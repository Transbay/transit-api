package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// The bridge: where this server gets its Bay Area realtime data.
//
// It used to fetch 511 directly, once a minute, on its own API key. The poller alongside
// it already fetches the same two protobufs every fifteen seconds for its own purposes,
// so this reads what the poller published instead. The map gets four times the freshness,
// the shared 511 budget stops being spent twice, and one process owns the upstream.
//
// The bytes in Redis are the 511 response unmodified. That is the entire contract, and it
// is what makes the swap safe: proto.Unmarshal runs on exactly what it used to run on, so
// enrichVehiclePositions and every GraphQL resolver below it are unchanged by
// construction rather than by inspection.
//
// Two things this is careful about, because both fail silently:
//
//   - It refuses a contract version it does not recognise. A poller that reshapes these
//     keys bumps the version; reading the new shape with the old assumptions would
//     produce plausible, wrong buses rather than an error.
//   - It keeps the direct 511 path as a fallback. Redis becoming a hard dependency of a
//     server that has never needed it is a real change in failure modes, so until the
//     bridge has proven itself, BRIDGE_FALLBACK lets a Redis outage cost freshness
//     instead of costing the map.
const bridgeContractVersion = 1

type bridgeSettings struct {
	enabled     bool
	region      string
	corrections bool
	fallback    bool
	maxAge      time.Duration
}

var (
	bridge      bridgeSettings
	redisClient *redis.Client
)

// initBridge reads the bridge configuration and connects, if it is turned on.
//
// Never fatal. A misconfigured bridge leaves the server polling 511 exactly as it did
// before, which is the behaviour we are trying to preserve a route back to.
func initBridge() {
	bridge = bridgeSettings{
		enabled:     os.Getenv("BRIDGE_ENABLED") == "true",
		region:      envOr("BRIDGE_REGION", "sfbay"),
		corrections: os.Getenv("BRIDGE_CORRECTIONS") == "true",
		// Defaults on, deliberately. Opting out of the safety net should be a decision
		// someone makes, not one they inherit.
		fallback: envOr("BRIDGE_FALLBACK", "true") == "true",
		maxAge:   time.Duration(envIntOr("BRIDGE_MAX_AGE_SECONDS", 90)) * time.Second,
	}

	if !bridge.enabled {
		log.Println("bridge: disabled, polling 511 directly")
		return
	}

	url := os.Getenv("REDIS_URL")
	if url == "" {
		log.Println("bridge: BRIDGE_ENABLED is set but REDIS_URL is not; polling 511 directly")
		bridge.enabled = false
		return
	}

	opts, err := redis.ParseURL(url)
	if err != nil {
		log.Printf("bridge: unusable REDIS_URL (%v); polling 511 directly", err)
		bridge.enabled = false
		return
	}
	redisClient = redis.NewClient(opts)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := redisClient.Ping(ctx).Err(); err != nil {
		// Not fatal and not disabling: Redis may simply be slow to come up beside us, and
		// every read already falls back on its own. Disabling here would mean a
		// twenty-second startup race decided whether we spend 511 budget all day.
		log.Printf("bridge: Redis not reachable at startup (%v); will retry on each refresh", err)
	}
	log.Printf("bridge: enabled, region=%s corrections=%v fallback=%v",
		bridge.region, bridge.corrections, bridge.fallback)
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func envIntOr(name string, fallback int) int {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

// bridgeUnavailable marks a read that could not be served, so callers can decide whether
// to fall back rather than having that decided for them.
type bridgeUnavailable struct{ reason string }

func (e *bridgeUnavailable) Error() string { return "bridge unavailable: " + e.reason }

// bridgeFeed reads one republished protobuf: kind is "vp" or "tu".
//
// Returns the bytes exactly as the poller stored them, plus when they were fetched from
// 511 — which is what the GraphQL `fetchedAt` should reflect, not the moment we read
// Redis. Those differ by up to a poll interval and the difference is the whole point.
func bridgeFeed(ctx context.Context, kind string) ([]byte, time.Time, error) {
	if !bridge.enabled || redisClient == nil {
		return nil, time.Time{}, &bridgeUnavailable{"not enabled"}
	}

	key := fmt.Sprintf("hw:%s:%s", kind, bridge.region)

	// One round trip for all three. The version has to be checked against the same read
	// that produced the payload, or a poller deploying mid-fetch could hand us new bytes
	// alongside the old version stamp.
	pipe := redisClient.Pipeline()
	payloadCmd := pipe.Get(ctx, key)
	atCmd := pipe.Get(ctx, key+":at")
	versionCmd := pipe.Get(ctx, "hw:bridge:v")
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return nil, time.Time{}, &bridgeUnavailable{err.Error()}
	}

	payload, err := payloadCmd.Bytes()
	if err != nil || len(payload) == 0 {
		return nil, time.Time{}, &bridgeUnavailable{"no " + kind + " published for " + bridge.region}
	}

	if v, err := versionCmd.Result(); err != nil {
		return nil, time.Time{}, &bridgeUnavailable{"no contract version published"}
	} else if strings.TrimSpace(v) != strconv.Itoa(bridgeContractVersion) {
		// Refusing rather than guessing. Reading a reshaped feed with these assumptions
		// would not error, it would draw wrong buses.
		return nil, time.Time{}, &bridgeUnavailable{
			fmt.Sprintf("contract version %s, this build understands %d", v, bridgeContractVersion),
		}
	}

	// The payload carries a TTL, so anything Redis returns is already bounded in age.
	// `:at` refines that to the real upstream fetch time when present.
	fetchedAt := time.Now()
	if raw, err := atCmd.Result(); err == nil {
		if parsed, err := time.Parse(time.RFC3339Nano, raw); err == nil {
			fetchedAt = parsed
		}
	}

	if age := time.Since(fetchedAt); age > bridge.maxAge {
		return nil, time.Time{}, &bridgeUnavailable{
			fmt.Sprintf("%s is %s old", kind, age.Round(time.Second)),
		}
	}

	return payload, fetchedAt, nil
}

// A corrected departure for one trip at one stop, as the poller publishes it.
type bridgeCorrection struct {
	Predicted  int64  `json:"p"`
	Low        int64  `json:"lo"`
	High       int64  `json:"hi"`
	Confidence string `json:"c"`
	Applied    int64  `json:"d"`
}

// Corrections are read once per refresh and held for the enrichment pass, mirroring how
// bayAreaTripUpdates is already carried between the fetch and the enrich.
var (
	correctionsMu    sync.RWMutex
	correctionsByKey map[string]bridgeCorrection
	correctionsAt    time.Time
)

// refreshCorrections pulls the current correction set. Best effort throughout: without it
// the delay figure falls back to what the agency said, which is what it is today.
func refreshCorrections(ctx context.Context) {
	if !bridge.enabled || !bridge.corrections || redisClient == nil {
		return
	}

	raw, err := redisClient.HGetAll(ctx, "hw:corr:"+bridge.region).Result()
	if err != nil {
		log.Printf("bridge: corrections unavailable: %v", err)
		return
	}

	next := make(map[string]bridgeCorrection, len(raw))
	for field, value := range raw {
		var c bridgeCorrection
		if err := json.Unmarshal([]byte(value), &c); err != nil {
			continue
		}
		next[field] = c
	}

	correctionsMu.Lock()
	correctionsByKey = next
	correctionsAt = time.Now()
	correctionsMu.Unlock()
}

// correctedDeparture returns the corrected departure time for a trip at a stop, in epoch
// seconds, and whether one was found.
//
// The confidence floor is applied by the publisher, not here: a consumer that decides for
// itself what to trust is a second place for that judgement to drift.
func correctedDeparture(tripID, stopID string) (int64, bool) {
	if !bridge.corrections {
		return 0, false
	}
	correctionsMu.RLock()
	defer correctionsMu.RUnlock()
	if correctionsByKey == nil {
		return 0, false
	}
	// Unit separator, matching how the publisher packs the compound key.
	c, ok := correctionsByKey[tripID+"\x1f"+stopID]
	if !ok || c.Predicted == 0 {
		return 0, false
	}
	return c.Predicted, true
}

// bridgeStatus reports what /health needs to show.
func bridgeStatus() map[string]interface{} {
	correctionsMu.RLock()
	count := len(correctionsByKey)
	at := correctionsAt
	correctionsMu.RUnlock()

	status := map[string]interface{}{
		"enabled":     bridge.enabled,
		"region":      bridge.region,
		"corrections": bridge.corrections,
		"fallback":    bridge.fallback,
	}
	if bridge.corrections {
		status["correctionCount"] = count
		if !at.IsZero() {
			status["correctionsAgeSeconds"] = int(time.Since(at).Seconds())
		}
	}
	return status
}

// healthHandler is what a platform health check hits, and what tells you the bridge is
// quietly broken.
//
// The map keeps rendering happily on whatever it fetched last, so a dead bridge looks
// exactly like working software until someone notices the buses have stopped moving.
// `vehiclePositionsAgeSeconds` climbing is the signal.
func healthHandler(w http.ResponseWriter, r *http.Request) {
	vehiclePositionsCacheMu.RLock()
	vpAt := vehiclePositionsCacheTime
	vpErr := vehiclePositionsCacheErr
	hasVP := vehiclePositionsCacheParsed != nil
	vehiclePositionsCacheMu.RUnlock()

	body := map[string]interface{}{
		"status": "ok",
		"bridge": bridgeStatus(),
		"vehiclePositions": map[string]interface{}{
			"loaded": hasVP,
		},
	}

	if !vpAt.IsZero() {
		vp := body["vehiclePositions"].(map[string]interface{})
		vp["fetchedAt"] = vpAt.UTC().Format(time.RFC3339)
		vp["ageSeconds"] = int(time.Since(vpAt).Seconds())
	}
	if vpErr != nil {
		body["vehiclePositions"].(map[string]interface{})["lastError"] = vpErr.Error()
	}
	if !hasVP {
		// No positions means an empty map, which is the one state worth failing a health
		// check over — everything else here is informational.
		body["status"] = "degraded"
		w.WriteHeader(http.StatusServiceUnavailable)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}
