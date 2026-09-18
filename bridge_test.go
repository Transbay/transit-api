package main

import (
	"context"
	"errors"
	"encoding/json"
	"os"
	"strconv"
	"testing"
	"time"

	gtfs "github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"github.com/redis/go-redis/v9"
	"google.golang.org/protobuf/proto"
)

// The read side of the bridge, against a real Redis.
//
// The claim under test is the same one the publisher asserts from its end: the protobuf
// that comes out is the protobuf that went in. Both halves check it because the failure is
// invisible — a mangled feed does not error, it draws slightly wrong buses — and the two
// services are written in different languages by different people at different times.
//
// Skipped unless Redis is configured, so `go test ./...` stays offline by default:
//
//	TEST_REDIS_URL=redis://localhost:6379/9 go test ./...
func bridgeTestRedis(t *testing.T) *redis.Client {
	t.Helper()
	url := os.Getenv("TEST_REDIS_URL")
	if url == "" {
		t.Skip("set TEST_REDIS_URL to run bridge tests")
	}
	opts, err := redis.ParseURL(url)
	if err != nil {
		t.Fatalf("unusable TEST_REDIS_URL: %v", err)
	}
	client := redis.NewClient(opts)
	if err := client.Ping(context.Background()).Err(); err != nil {
		t.Skipf("Redis not reachable: %v", err)
	}
	return client
}

// withBridge points the package-level bridge at a test region and restores it after.
func withBridge(t *testing.T, client *redis.Client, corrections bool) {
	t.Helper()
	prevBridge, prevClient := bridge, redisClient
	bridge = bridgeSettings{
		enabled:     true,
		region:      "gotest",
		corrections: corrections,
		fallback:    true,
		maxAge:      90 * time.Second,
	}
	redisClient = client
	t.Cleanup(func() {
		bridge, redisClient = prevBridge, prevClient
		client.Del(context.Background(),
			"hw:vp:gotest", "hw:vp:gotest:at", "hw:tu:gotest", "hw:corr:gotest", "hw:bridge:v")
	})
}

func TestBridgeFeedIsByteIdentical(t *testing.T) {
	client := bridgeTestRedis(t)
	withBridge(t, client, false)
	ctx := context.Background()

	// Bytes that a UTF-8 round trip would destroy: a lone 0xFF, an embedded NUL, an
	// unpaired surrogate encoding. A real GTFS-realtime payload contains all of these.
	want := []byte{0x0a, 0x00, 0xff, 0xfe, 0x1f, 0x80, 0x7f, 0x00, 0xc3, 0x28}
	at := time.Now().UTC().Add(-3 * time.Second)

	client.Set(ctx, "hw:vp:gotest", want, time.Minute)
	client.Set(ctx, "hw:vp:gotest:at", at.Format(time.RFC3339Nano), time.Minute)
	client.Set(ctx, "hw:bridge:v", strconv.Itoa(bridgeContractVersion), 0)

	got, fetchedAt, err := bridgeFeed(ctx, "vp")
	if err != nil {
		t.Fatalf("bridgeFeed: %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("feed was altered in transit:\n got %x\nwant %x", got, want)
	}
	// The upstream fetch time, not the moment we read Redis — that difference is what the
	// client renders as data age.
	if delta := fetchedAt.Sub(at); delta > time.Second || delta < -time.Second {
		t.Fatalf("fetchedAt should track the publisher's stamp, got %v want ~%v", fetchedAt, at)
	}
}

func TestBridgeRefusesUnknownContractVersion(t *testing.T) {
	client := bridgeTestRedis(t)
	withBridge(t, client, false)
	ctx := context.Background()

	client.Set(ctx, "hw:vp:gotest", []byte{1, 2, 3}, time.Minute)
	client.Set(ctx, "hw:vp:gotest:at", time.Now().UTC().Format(time.RFC3339Nano), time.Minute)
	client.Set(ctx, "hw:bridge:v", strconv.Itoa(bridgeContractVersion+1), 0)

	// Refusing is the whole point: a reshaped feed read with these assumptions would not
	// error, it would produce plausible and wrong output. Falling back to 511 is correct.
	if _, _, err := bridgeFeed(ctx, "vp"); err == nil {
		t.Fatal("accepted a contract version this build does not understand")
	}

	client.Del(ctx, "hw:bridge:v")
	if _, _, err := bridgeFeed(ctx, "vp"); err == nil {
		t.Fatal("accepted a feed published with no contract version at all")
	}
}

func TestBridgeRefusesStaleFeed(t *testing.T) {
	client := bridgeTestRedis(t)
	withBridge(t, client, false)
	ctx := context.Background()

	client.Set(ctx, "hw:vp:gotest", []byte{1, 2, 3}, time.Minute)
	client.Set(ctx, "hw:bridge:v", strconv.Itoa(bridgeContractVersion), 0)
	// Published ten minutes ago: the poller has stopped, and these positions describe
	// streets the buses have long since left.
	client.Set(ctx, "hw:vp:gotest:at",
		time.Now().UTC().Add(-10*time.Minute).Format(time.RFC3339Nano), time.Minute)

	if _, _, err := bridgeFeed(ctx, "vp"); err == nil {
		t.Fatal("served a ten-minute-old feed as current")
	}
}

func TestBridgeMissingFeedIsUnavailableNotEmpty(t *testing.T) {
	client := bridgeTestRedis(t)
	withBridge(t, client, false)
	ctx := context.Background()
	client.Set(ctx, "hw:bridge:v", strconv.Itoa(bridgeContractVersion), 0)

	// Nothing published. This has to read as "fall back to 511", never as "the region has
	// no vehicles", which would empty the map and look like a quiet night.
	if _, _, err := bridgeFeed(ctx, "vp"); err == nil {
		t.Fatal("an unpublished feed was treated as a valid empty one")
	}
}

func TestCorrectedDepartureLookup(t *testing.T) {
	client := bridgeTestRedis(t)
	withBridge(t, client, true)
	ctx := context.Background()

	payload, _ := json.Marshal(bridgeCorrection{
		Predicted: 1757001240, Low: 1757001100, High: 1757001400, Confidence: "high", Applied: -1008,
	})
	client.HSet(ctx, "hw:corr:gotest", "SF:1049821\x1f473230", string(payload))
	refreshCorrections(ctx)

	got, ok := correctedDeparture("SF:1049821", "473230")
	if !ok || got != 1757001240 {
		t.Fatalf("correctedDeparture = %d, %v; want 1757001240, true", got, ok)
	}

	if _, ok := correctedDeparture("SF:1049821", "999999"); ok {
		t.Fatal("matched a stop that has no correction")
	}
	if _, ok := correctedDeparture("SF:nosuchtrip", "473230"); ok {
		t.Fatal("matched a trip that has no correction")
	}

	// With corrections switched off the delay figure must fall straight through to the
	// agency's own prediction, so this gate has to hold independently of what is in Redis.
	bridge.corrections = false
	if _, ok := correctedDeparture("SF:1049821", "473230"); ok {
		t.Fatal("returned a correction while corrections were disabled")
	}
}

func TestDirectFetchThrottle(t *testing.T) {
	// The ticker runs at five seconds because a bridge read is free. Going to 511 at that
	// rate would spend an hour's key budget in five minutes, so the fallback keeps the
	// pre-bridge cadence regardless of how often it is asked.
	directFetchMu.Lock()
	delete(directFetchAt, "throttletest")
	directFetchMu.Unlock()

	if !claimDirectFetch("throttletest") {
		t.Fatal("first fetch should be allowed")
	}
	for i := 0; i < 12; i++ {
		if claimDirectFetch("throttletest") {
			t.Fatalf("fetch %d slipped through the throttle", i)
		}
	}

	// Independent per feed: vehiclepositions being throttled must not stall tripupdates.
	if !claimDirectFetch("otherfeed") {
		t.Fatal("throttle leaked across feeds")
	}
}

// BART's synthesised trains arrive on their own key and are appended, never spliced into
// the 511 bytes. Stale or absent means no extra vehicles, not an error.
func TestBridgeExtraVehicles(t *testing.T) {
	client := bridgeTestRedis(t)
	withBridge(t, client, false)
	ctx := context.Background()
	key := "hw:vpx:gotest"
	t.Cleanup(func() { client.Del(ctx, key, key+":at") })

	if got := bridgeExtraVehicles(ctx); got != nil {
		t.Fatalf("absent key produced %d vehicles", len(got))
	}

	tripID := "BA:1234567"
	payload, err := proto.Marshal(&gtfs.FeedMessage{
		Header: &gtfs.FeedHeader{GtfsRealtimeVersion: proto.String("2.0")},
		Entity: []*gtfs.FeedEntity{{
			Id: proto.String(tripID),
			Vehicle: &gtfs.VehiclePosition{
				Trip:     &gtfs.TripDescriptor{TripId: proto.String(tripID)},
				Position: &gtfs.Position{Latitude: proto.Float32(37.8), Longitude: proto.Float32(-122.27)},
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	client.Set(ctx, key, payload, time.Minute)
	client.Set(ctx, key+":at", time.Now().UTC().Format(time.RFC3339Nano), time.Minute)

	got := bridgeExtraVehicles(ctx)
	if len(got) != 1 || got[0].GetVehicle().GetTrip().GetTripId() != tripID {
		t.Fatalf("expected the one BART train back, got %v", got)
	}

	client.Set(ctx, key+":at", time.Now().Add(-10*time.Minute).UTC().Format(time.RFC3339Nano), time.Minute)
	if got := bridgeExtraVehicles(ctx); got != nil {
		t.Fatalf("a stale feed was used: %d vehicles", len(got))
	}
}

// With the bridge off, 511 is the only source and the five-second tick must not reach it
// directly. This was the failure: every tick fetched, 720 an hour against 60-an-hour keys.
func TestDirectFetchThrottledWithBridgeOff(t *testing.T) {
	prev := bridge
	bridge = bridgeSettings{enabled: false}
	t.Cleanup(func() { bridge = prev })

	for _, kind := range []string{"vp", "tu"} {
		directFetchMu.Lock()
		directFetchAt[kind] = time.Now()
		directFetchMu.Unlock()

		called := false
		_, _, err := fetchFeedBytes(kind, "http://127.0.0.1:0/", func() (string, error) {
			called = true
			return "k", nil
		}, kind)
		if !errors.Is(err, errSkipCycle) || called {
			t.Fatalf("%s: a fetch inside the floor reached 511 (err=%v)", kind, err)
		}

		directFetchMu.Lock()
		delete(directFetchAt, kind)
		directFetchMu.Unlock()
	}
}
