package main

import (
	"archive/zip"
	"compress/gzip"
	"compress/zlib"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	gtfs "github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"github.com/joho/godotenv"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

const (
	baseURL             = "http://api.511.org/transit/tripupdates"
	vehiclePositionsURL = "http://api.511.org/transit/vehiclepositions"
	datafeedsBase       = "http://api.511.org/transit/datafeeds"
	agencyParam         = "RG"
	operatorParam       = "RG"
)

const (
	vehiclePositionsCacheInterval = 1 * time.Minute
	tripUpdatesCacheInterval      = 1 * time.Minute
	datafeedsRefreshInterval      = 1 * time.Hour
)

var (
	datafeedsFilePath             string
	datafeedsDir                  string
	vehicleTypesFilePath          string
	vehiclePositionsCacheFilePath string
	shapesDir                     string
	tripDetailsDir                string
	tripDataDir                   string
	datafeedsJSONFiles            []string
	datafeedsFiles                []string
	datafeedsFileMap              map[string]datafeedEntry
	routeShapesCache              []byte
	routeShapesCacheMu            sync.RWMutex
)

var (
	vehiclePositionsCacheMu      sync.RWMutex
	vehiclePositionsCachePayload []byte
	vehiclePositionsCacheParsed  interface{}
	vehiclePositionsCacheErr     error
	vehiclePositionsCacheTime    time.Time
)

func setVehiclePositionsCache(payload []byte, t time.Time) {
	vehiclePositionsCacheMu.Lock()
	vehiclePositionsCachePayload = payload
	vehiclePositionsCacheTime = t
	var parsed interface{}
	if err := json.Unmarshal(payload, &parsed); err == nil {
		vehiclePositionsCacheParsed = parsed
	} else {
		vehiclePositionsCacheParsed = nil
	}
	vehiclePositionsCacheMu.Unlock()
}

var (
	tripUpdatesCacheMu      sync.RWMutex
	tripUpdatesCachePayload []byte
	tripUpdatesCacheErr     error
	tripUpdatesCacheTime    time.Time
)

var bayAreaTripUpdates tripUpdateStore

func main() {
	if err := godotenv.Load(); err != nil {
		log.Println(".env not found or could not be loaded, falling back to existing env")
	}
	workingDir, err := os.Getwd()
	if err != nil {
		log.Fatalf("failed to get working directory: %v", err)
	}
	datafeedsFilePath = filepath.Join(workingDir, "data", "gtfs.zip")
	datafeedsDir = filepath.Join(workingDir, "data", "gtfs")
	vehicleTypesFilePath = filepath.Join(workingDir, "vehicle_types.json")
	vehiclePositionsCacheFilePath = filepath.Join(workingDir, "data", "vehicle_positions.json")
	shapesDir = filepath.Join(workingDir, "data", "shapes")
	tripDetailsDir = filepath.Join(workingDir, "data", "tripdetails")
	tripDataDir = filepath.Join(workingDir, "data", "tripdata")
	if err := initMongoDB(); err != nil {
		log.Printf("MongoDB not available, image features disabled: %v", err)
	} else {
		defer closeMongoDB()
	}
	if os.Getenv("LOCATIONS_API_KEY") == "" {
		log.Fatalln("LOCATIONS_API_KEY not set")
	}
	go runDatafeedsRefresher()
	go runVehiclePositionsRefresher()
	go runTripUpdatesRefresher()
	startSeattleRegion()
	startSacrtRegion()
	startElkRegion()
	if data, err := os.ReadFile(vehiclePositionsCacheFilePath); err == nil && len(data) > 0 {
		setVehiclePositionsCache(data, time.Now())
		log.Println("Loaded cached vehicle positions from disk")
	} else {
		log.Println("No disk cache for vehicle positions, waiting for initial fetch...")
	}
	log.Println("Waiting for initial vehicle positions...")
	for i := 0; i < 60; i++ {
		vehiclePositionsCacheMu.RLock()
		hasPayload := vehiclePositionsCachePayload != nil
		vehiclePositionsCacheMu.RUnlock()
		if hasPayload {
			log.Println("Initial vehicle positions received")
			break
		}
		time.Sleep(1 * time.Second)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api", graphQLHandler)
	mux.HandleFunc("/api/images/upload", createImageHandler)
	mux.HandleFunc("/api/images/vehicle/{vehicle_id}", vehicleImagesHandler)
	mux.HandleFunc("/api/images/vehicle-ids", vehicleIdsWithImagesHandler)
	mux.HandleFunc("/api/images/file/{id}", serveImageFileHandler)
	mux.HandleFunc("/api/images/{id}", deleteImageHandler)
	mux.HandleFunc("/api/images", vehicleImagesListHandler)
	corsHandler := func(h http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			if r.Method == "OPTIONS" {
				w.WriteHeader(http.StatusOK)
				return
			}
			h.ServeHTTP(w, r)
		})
	}
	server := &http.Server{
		Addr:              ":8081",
		Handler:           corsHandler(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if err := refreshDatafeeds(); err != nil {
			log.Fatalf("failed to load datafeeds: %v", err)
		}
	}()
	log.Println("listening on :8081")
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}

func tripUpdatesHandler(w http.ResponseWriter, r *http.Request) {
	tripUpdatesCacheMu.RLock()
	payload := tripUpdatesCachePayload
	cacheErr := tripUpdatesCacheErr
	cacheTime := tripUpdatesCacheTime
	tripUpdatesCacheMu.RUnlock()
	if cacheErr != nil {
		http.Error(w, fmt.Sprintf("trip updates cache unavailable: %v", cacheErr), http.StatusBadGateway)
		return
	}
	if payload == nil {
		http.Error(w, "trip updates cache not yet populated", http.StatusServiceUnavailable)
		return
	}
	envelope := map[string]interface{}{
		"fetchedAt": cacheTime.UTC().Format(time.RFC3339Nano),
		"data":      json.RawMessage(payload),
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Cache-Time", cacheTime.UTC().Format(http.TimeFormat))
	if err := json.NewEncoder(w).Encode(envelope); err != nil {
		http.Error(w, "failed to write response", http.StatusInternalServerError)
		return
	}
}

func runTripUpdatesRefresher() {
	if err := refreshTripUpdates(); err != nil {
		log.Printf("trip updates refresh failed: %v", err)
	}
	ticker := time.NewTicker(tripUpdatesCacheInterval)
	defer ticker.Stop()
	for range ticker.C {
		if err := refreshTripUpdates(); err != nil {
			log.Printf("trip updates refresh failed: %v", err)
		}
	}
}

func refreshTripUpdates() error {
	apiKey := os.Getenv("TRIP_UPDATES_API_KEY")
	if apiKey == "" {
		return fmt.Errorf("TRIP_UPDATES_API_KEY env var is not set")
	}
	client := &http.Client{Timeout: 15 * time.Second}
	url := fmt.Sprintf("%s?api_key=%s&agency=%s", baseURL, apiKey, agencyParam)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Accept", "application/x-protobuf")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to fetch trip updates: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("upstream error: %s", string(body))
	}
	body, err := readResponseBody(resp)
	if err != nil {
		return fmt.Errorf("failed to read upstream response: %w", err)
	}
	var feed gtfs.FeedMessage
	if err := proto.Unmarshal(body, &feed); err != nil {
		return fmt.Errorf("invalid GTFS-realtime protobuf from upstream: %w", err)
	}
	bayAreaTripUpdates.set(tripUpdatePredictions(&feed))
	marshaler := protojson.MarshalOptions{Indent: "  "}
	payload, err := marshaler.Marshal(&feed)
	if err != nil {
		return fmt.Errorf("failed to encode response: %w", err)
	}
	tripUpdatesCacheMu.Lock()
	tripUpdatesCachePayload = payload
	tripUpdatesCacheErr = nil
	tripUpdatesCacheTime = time.Now()
	tripUpdatesCacheMu.Unlock()
	return nil
}

func enrichVehiclePositions(payload []byte) []byte {
	stopsData := loadStopsData()
	tripsData := loadTripsData()
	routesData := loadRoutesData()
	loc := loadAgencyTimezone()
	var feed map[string]interface{}
	if err := json.Unmarshal(payload, &feed); err != nil {
		return payload
	}
	entities, ok := feed["entity"].([]interface{})
	if !ok {
		return payload
	}
	now := time.Now().In(loc)
	nowSec := now.Hour()*3600 + now.Minute()*60 + now.Second()
	for _, e := range entities {
		entity, ok := e.(map[string]interface{})
		if !ok {
			continue
		}
		vehicle, ok := entity["vehicle"].(map[string]interface{})
		if !ok {
			continue
		}
		if stopID, ok := vehicle["stopId"].(string); ok && stopID != "" {
			if stop, ok := stopsData[stopID]; ok && stop.stop_name != "" {
				vehicle["stopName"] = stop.stop_name
			}
		}
		trip, ok := vehicle["trip"].(map[string]interface{})
		if ok {
			tripID, _ := trip["tripId"].(string)
			if tripInfo, found := tripsData[tripID]; found {
				trip["tripInfoFound"] = true
				trip["tripHeadsign"] = tripInfo.trip_headsign
				trip["serviceId"] = tripInfo.service_id
				trip["shapeId"] = tripInfo.shape_id
				trip["blockId"] = tripInfo.block_id
				trip["tripShortName"] = tripInfo.trip_short_name
				if routeID, _ := trip["routeId"].(string); routeID == "" {
					trip["routeId"] = tripInfo.route_id
				}
				if _, hasDir := trip["directionId"]; !hasDir {
					d, _ := strconv.Atoi(tripInfo.direction_id)
					trip["directionId"] = d
				}
				if routeID, _ := trip["routeId"].(string); routeID != "" && routeID != tripInfo.route_id {
					if effTrip := firstTripOnRoute(routeID); effTrip != "" {
						if effInfo, ok := tripsData[effTrip]; ok {
							trip["tripId"] = effTrip
							trip["shapeId"] = effInfo.shape_id
						}
					}
				}
				if routeID, _ := trip["routeId"].(string); routeID != "" {
					if route, ok := routesData[routeID]; ok && route.shortName != "" {
						vehicle["routeShortName"] = route.shortName
					}
				}
			}
		}
		if trip != nil {
			if tripID, _ := trip["tripId"].(string); tripID != "" {
				if stopID, _ := vehicle["stopId"].(string); stopID != "" {
					stopTimes := loadStopTimesForTrip(tripID)
					for _, st := range stopTimes {
						if st.stop_id == stopID {
							scheduledSec := parseGTFSSeconds(st.departure_time)
							delay := nowSec - scheduledSec
							if pred, ok := bayAreaTripUpdates.predictedDeparture(tripID, stopID); ok {
								p := time.Unix(pred, 0).In(loc)
								delay = (p.Hour()*3600 + p.Minute()*60 + p.Second()) - scheduledSec
							}
							trip["delay"] = delay
							break
						}
					}
				}
			}
		}
		if vehObj, ok := vehicle["vehicle"].(map[string]interface{}); ok {
			vehicleID, _ := vehObj["id"].(string)
			if vehicleID == "" {
				vehicleID, _ = entity["id"].(string)
			}
			agencyCode := ""
			if trip, ok := vehicle["trip"].(map[string]interface{}); ok {
				if tripID, ok := trip["tripId"].(string); ok && tripID != "" {
					if idx := strings.Index(tripID, ":"); idx >= 0 {
						agencyCode = tripID[:idx]
					} else if idx := strings.LastIndex(tripID, "~"); idx >= 0 {
						agencyCode = tripID[:idx]
					}
					if agencyCode == "" {
						trips := loadTripsData()
						if ti, ok := trips[tripID]; ok && ti.route_id != "" {
							if idx := strings.Index(ti.route_id, ":"); idx >= 0 {
								agencyCode = ti.route_id[:idx]
							}
						}
					}
				}
			}
			if agencyCode != "" && vehicleID != "" {
				if vti := lookupVehicleType(agencyCode, vehicleID); vti != nil {
					vehicle["vehicleYear"] = vti.Year
					vehicle["vehicleMake"] = vti.Make
					vehicle["vehicleModel"] = vti.Model
					vehicle["vehicleFuel"] = vti.Fuel
					vehicle["vehicleLength"] = vti.Length
					vehicle["vehicleIconCode"] = vti.IconCode
				}
			}
		}
	}
	enriched, err := json.Marshal(feed)
	if err != nil {
		return payload
	}
	return enriched
}

func vehiclePositionsHandler(w http.ResponseWriter, r *http.Request) {
	vehiclePositionsCacheMu.RLock()
	payload := vehiclePositionsCachePayload
	cacheErr := vehiclePositionsCacheErr
	cacheTime := vehiclePositionsCacheTime
	vehiclePositionsCacheMu.RUnlock()
	if cacheErr != nil {
		http.Error(w, fmt.Sprintf("vehicle positions cache unavailable: %v", cacheErr), http.StatusBadGateway)
		return
	}
	if payload == nil {
		if data, err := os.ReadFile(vehiclePositionsCacheFilePath); err == nil && len(data) > 0 {
			payload = data
			log.Println("Serving vehicle positions from disk fallback")
		} else {
			http.Error(w, "vehicle positions cache not yet populated", http.StatusServiceUnavailable)
			return
		}
	}
	envelope := map[string]interface{}{
		"fetchedAt": cacheTime.UTC().Format(time.RFC3339Nano),
		"data":      json.RawMessage(payload),
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Cache-Time", cacheTime.UTC().Format(http.TimeFormat))
	if err := json.NewEncoder(w).Encode(envelope); err != nil {
		http.Error(w, "failed to write response", http.StatusInternalServerError)
		return
	}
}

func blockScheduleHandler(w http.ResponseWriter, r *http.Request) {
	vehicleID := r.URL.Query().Get("vehicle_id")
	tripID := r.URL.Query().Get("trip_id")
	var targetTripID string
	if tripID != "" {
		targetTripID = tripID
	} else if vehicleID != "" {
		vehiclePositionsCacheMu.RLock()
		vehiclePayload := vehiclePositionsCachePayload
		vehiclePositionsCacheMu.RUnlock()
		if vehiclePayload == nil {
			http.Error(w, "vehicle positions not available", http.StatusServiceUnavailable)
			return
		}
		var vehicleFeed gtfs.FeedMessage
		if err := proto.Unmarshal(vehiclePayload, &vehicleFeed); err != nil {
			http.Error(w, "failed to parse vehicle positions", http.StatusInternalServerError)
			return
		}
		for _, entity := range vehicleFeed.Entity {
			vehicle := entity.GetVehicle()
			if vehicle == nil {
				continue
			}
			v := vehicle.GetVehicle()
			if v == nil {
				continue
			}
			if v.GetId() == vehicleID || v.GetLabel() == vehicleID || entity.GetId() == vehicleID {
				trip := vehicle.GetTrip()
				if trip != nil {
					targetTripID = trip.GetTripId()
				}
				break
			}
		}
		if targetTripID == "" {
			http.Error(w, "vehicle not found", http.StatusNotFound)
			return
		}
	} else {
		http.Error(w, "vehicle_id or trip_id query parameter required", http.StatusBadRequest)
		return
	}
	tripsData := loadTripsData()
	tripInfo, ok := tripsData[targetTripID]
	if !ok {
		http.Error(w, "trip not found in GTFS", http.StatusNotFound)
		return
	}
	blockID := tripInfo.block_id
	serviceID := tripInfo.service_id
	if blockID == "" {
		http.Error(w, "vehicle has no block assignment", http.StatusNotFound)
		return
	}
	blockTrips := []TripInfo{}
	for _, t := range tripsData {
		if t.block_id == blockID && t.service_id == serviceID {
			blockTrips = append(blockTrips, t)
		}
	}
	sort.Slice(blockTrips, func(i, j int) bool {
		return blockTrips[i].trip_start_time < blockTrips[j].trip_start_time
	})
	stopsData := loadStopsData()
	type BlockScheduleResponse struct {
		BlockInfo struct {
			BlockID   string `json:"block_id"`
			ServiceID string `json:"service_id"`
		} `json:"block_info"`
		Schedule []BlockScheduleEntry `json:"schedule"`
	}
	blockSchedule := BlockScheduleResponse{}
	blockSchedule.BlockInfo.BlockID = blockID
	blockSchedule.BlockInfo.ServiceID = serviceID
	for _, trip := range blockTrips {
		stopTimes := loadStopTimesForTrip(trip.trip_id)
		sort.Slice(stopTimes, func(i, j int) bool {
			return stopTimes[i].stop_sequence < stopTimes[j].stop_sequence
		})
		var startStopName, endStopName string
		if len(stopTimes) > 0 {
			if startStop, ok := stopsData[stopTimes[0].stop_id]; ok {
				startStopName = startStop.stop_name
			}
			if endStop, ok := stopsData[stopTimes[len(stopTimes)-1].stop_id]; ok {
				endStopName = endStop.stop_name
			}
		}
		entry := BlockScheduleEntry{
			TripID:               trip.trip_id,
			RouteID:              trip.route_id,
			RouteShortName:       getRouteShortName(trip.route_id),
			RouteLongName:        getRouteLongName(trip.route_id),
			DirectionID:          trip.direction_id,
			StartTime:            trip.trip_start_time,
			EndTime:              trip.trip_end_time,
			HeadSign:             trip.trip_headsign,
			StartStopName:        startStopName,
			EndStopName:          endStopName,
			ShapeID:              trip.shape_id,
			WheelchairAccessible: trip.wheelchair_accessible,
			BikesAllowed:         trip.bikes_allowed,
		}
		blockSchedule.Schedule = append(blockSchedule.Schedule, entry)
	}
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	if err := enc.Encode(blockSchedule); err != nil {
		http.Error(w, "failed to encode response", http.StatusInternalServerError)
		return
	}
}

func runVehiclePositionsRefresher() {
	if err := refreshVehiclePositions(); err != nil {
		log.Printf("vehicle positions refresh failed: %v", err)
	}
	ticker := time.NewTicker(vehiclePositionsCacheInterval)
	defer ticker.Stop()
	for range ticker.C {
		if err := refreshVehiclePositions(); err != nil {
			log.Printf("vehicle positions refresh failed: %v", err)
		}
	}
}

func refreshVehiclePositions() error {
	apiKey := os.Getenv("LOCATIONS_API_KEY")
	if apiKey == "" {
		return fmt.Errorf("LOCATIONS_API_KEY not set")
	}
	client := &http.Client{Timeout: 15 * time.Second}
	url := fmt.Sprintf("%s?api_key=%s&agency=%s", vehiclePositionsURL, apiKey, agencyParam)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Accept", "application/x-protobuf")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to fetch vehicle positions: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("upstream error: %s", string(body))
	}
	body, err := readResponseBody(resp)
	if err != nil {
		return fmt.Errorf("failed to read upstream response: %w", err)
	}
	var feed gtfs.FeedMessage
	if err := proto.Unmarshal(body, &feed); err != nil {
		return fmt.Errorf("invalid GTFS-realtime protobuf from upstream: %w", err)
	}
	marshaler := protojson.MarshalOptions{Indent: "  "}
	marshaled, err := marshaler.Marshal(&feed)
	if err != nil {
		return fmt.Errorf("failed to encode response: %w", err)
	}
	payload := enrichVehiclePositions(marshaled)
	setVehiclePositionsCache(payload, time.Now())
	vehiclePositionsCacheMu.Lock()
	vehiclePositionsCacheErr = nil
	vehiclePositionsCacheMu.Unlock()
	if err := os.MkdirAll(filepath.Dir(vehiclePositionsCacheFilePath), 0o755); err != nil {
		log.Printf("Failed to create cache dir: %v", err)
	} else if err := os.WriteFile(vehiclePositionsCacheFilePath, payload, 0o644); err != nil {
		log.Printf("Failed to persist vehicle positions to disk: %v", err)
	}
	if tripDetailsDir != "" {
		go func() {
			if activeTripIDs := getActiveTripIDs(); len(activeTripIDs) > 0 {
				log.Printf("Pre-computing trip details for %d active vehicles", len(activeTripIDs))
				precomputeActiveTripDetails(activeTripIDs)
			}
		}()
	}
	return nil
}

func parseDirection(dir string) int32 {
	var d int32
	fmt.Sscanf(dir, "%d", &d)
	return d
}

func datafeedsZipHandler(w http.ResponseWriter, r *http.Request) {
	if datafeedsFilePath == "" {
		http.Error(w, "datafeed not initialized", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", "attachment; filename=gtfs.zip")
	http.ServeFile(w, r, datafeedsFilePath)
}

func datafeedsJSONIndexHandler(w http.ResponseWriter, r *http.Request) {
	if datafeedsJSONFiles == nil {
		http.Error(w, "datafeed json index not initialized", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	if err := enc.Encode(datafeedsJSONFiles); err != nil {
		http.Error(w, "failed to write response", http.StatusInternalServerError)
		return
	}
}

func datafeedsJSONFileHandler(w http.ResponseWriter, r *http.Request) {
	if datafeedsDir == "" {
		http.Error(w, "datafeed not initialized", http.StatusInternalServerError)
		return
	}
	relPath := strings.TrimPrefix(r.URL.Path, "/datafeeds/json/")
	if relPath == "" {
		http.NotFound(w, r)
		return
	}
	if !strings.HasSuffix(relPath, ".json") {
		http.NotFound(w, r)
		return
	}
	cleanRel := filepath.Clean(relPath)
	fullPath := filepath.Join(datafeedsDir, cleanRel)
	if !isSubpath(datafeedsDir, fullPath) {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	if _, err := os.Stat(fullPath); err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	http.ServeFile(w, r, fullPath)
}

var (
	shapesCache   map[string][][2]float64
	shapesOnce    sync.Once
	shapesCacheMu sync.RWMutex
)

func loadShapeForTrip(shapeID string) ([][2]float64, error) {
	shapesCacheMu.RLock()
	if shapesCache != nil {
		if coords, ok := shapesCache[shapeID]; ok {
			shapesCacheMu.RUnlock()
			return coords, nil
		}
		shapesCacheMu.RUnlock()
		return loadShapeFromDisk(shapeID)
	}
	shapesCacheMu.RUnlock()
	shapesOnce.Do(func() {
		entry, ok := datafeedsFileMap["shapes"]
		if !ok {
			return
		}
		file, err := os.Open(entry.path)
		if err != nil {
			log.Printf("failed to open shapes.txt: %v", err)
			return
		}
		defer file.Close()
		reader := csv.NewReader(file)
		reader.FieldsPerRecord = -1
		reader.LazyQuotes = true
		headers, err := reader.Read()
		if err != nil {
			log.Printf("failed to read shapes.txt headers: %v", err)
			return
		}
		type point struct {
			lat float64
			lon float64
			seq int
		}
		shapePoints := make(map[string][]point)
		for {
			record, err := reader.Read()
			if err == io.EOF {
				break
			}
			if err != nil {
				log.Printf("error reading shapes.txt: %v", err)
				continue
			}
			rec := make(map[string]string, len(headers))
			for i, h := range headers {
				if i < len(record) {
					rec[h] = record[i]
				}
			}
			sid := rec["shape_id"]
			if sid == "" {
				continue
			}
			lat, _ := strconv.ParseFloat(rec["shape_pt_lat"], 64)
			lon, _ := strconv.ParseFloat(rec["shape_pt_lon"], 64)
			seq, _ := strconv.Atoi(rec["shape_pt_sequence"])
			shapePoints[sid] = append(shapePoints[sid], point{lat: lat, lon: lon, seq: seq})
		}
		result := make(map[string][][2]float64, len(shapePoints))
		for sid, pts := range shapePoints {
			sort.Slice(pts, func(i, j int) bool {
				return pts[i].seq < pts[j].seq
			})
			coords := make([][2]float64, len(pts))
			for i, p := range pts {
				coords[i] = [2]float64{p.lat, p.lon}
			}
			result[sid] = coords
		}
		shapesCacheMu.Lock()
		shapesCache = result
		shapesCacheMu.Unlock()
		log.Printf("Loaded %d shapes into cache", len(result))
	})
	shapesCacheMu.RLock()
	defer shapesCacheMu.RUnlock()
	if shapesCache == nil {
		return loadShapeFromDisk(shapeID)
	}
	return shapesCache[shapeID], nil
}

func loadShapeFromDisk(shapeID string) ([][2]float64, error) {
	entry, ok := datafeedsFileMap["shapes"]
	if !ok {
		return nil, fmt.Errorf("shapes data not available")
	}
	file, err := os.Open(entry.path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	reader := csv.NewReader(file)
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	headers, err := reader.Read()
	if err != nil {
		return nil, err
	}
	type point struct {
		lat float64
		lon float64
		seq int
	}
	var points []point
	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		rec := make(map[string]string, len(headers))
		for i, h := range headers {
			if i < len(record) {
				rec[h] = record[i]
			}
		}
		if rec["shape_id"] != shapeID {
			continue
		}
		lat, _ := strconv.ParseFloat(rec["shape_pt_lat"], 64)
		lon, _ := strconv.ParseFloat(rec["shape_pt_lon"], 64)
		seq, _ := strconv.Atoi(rec["shape_pt_sequence"])
		points = append(points, point{lat: lat, lon: lon, seq: seq})
	}
	if len(points) == 0 {
		return nil, nil
	}
	sort.Slice(points, func(i, j int) bool {
		return points[i].seq < points[j].seq
	})
	coords := make([][2]float64, len(points))
	for i, p := range points {
		coords[i] = [2]float64{p.lat, p.lon}
	}
	return coords, nil
}

func tripDetailHandler(w http.ResponseWriter, r *http.Request) {
	tripID := r.URL.Query().Get("trip_id")
	if tripID == "" {
		log.Println("tripDetail: missing trip_id param")
		http.Error(w, "trip_id query param required", http.StatusBadRequest)
		return
	}
	log.Printf("tripDetail: loading trip_id=%s", tripID)
	if tripDetailsDir != "" {
		tripPath := filepath.Join(tripDetailsDir, tripID+".json")
		if _, err := os.Stat(tripPath); err == nil {
			log.Printf("tripDetail: serving pre-computed file for trip_id=%s", tripID)
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "public, max-age=300")
			http.ServeFile(w, r, tripPath)
			return
		}
	}
	log.Printf("tripDetail: pre-computed file not found, building from CSVs for trip_id=%s", tripID)
	trips := loadTripsData()
	stops := loadStopsData()
	trip, ok := trips[tripID]
	if !ok {
		log.Printf("tripDetail: trip_id=%s not found", tripID)
		http.Error(w, "trip not found", http.StatusNotFound)
		return
	}
	times := loadStopTimesForTrip(tripID)
	if times == nil {
		times = []StopTimeInfo{}
	}
	schedule := make([]map[string]interface{}, 0, len(times))
	for _, st := range times {
		stop := stops[st.stop_id]
		entry := map[string]interface{}{
			"stop_id":        st.stop_id,
			"stop_sequence":  st.stop_sequence,
			"arrival_time":   st.arrival_time,
			"departure_time": st.departure_time,
			"stop_name":      stop.stop_name,
			"stop_lat":       stop.stop_lat,
			"stop_lon":       stop.stop_lon,
		}
		schedule = append(schedule, entry)
	}
	var shapeCoords [][2]float64
	if trip.shape_id != "" {
		coords, err := loadShapeForTrip(trip.shape_id)
		if err == nil {
			shapeCoords = coords
		}
	}
	result := map[string]interface{}{
		"trip_id":         trip.trip_id,
		"route_id":        trip.route_id,
		"service_id":      trip.service_id,
		"trip_headsign":   trip.trip_headsign,
		"direction_id":    trip.direction_id,
		"shape_id":        trip.shape_id,
		"block_id":        trip.block_id,
		"trip_short_name": trip.trip_short_name,
		"shape":           shapeCoords,
		"schedule":        schedule,
	}
	log.Printf("tripDetail: returning trip_id=%s with %d stops, %d shape points", tripID, len(schedule), len(shapeCoords))
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=60")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	enc.Encode(result)
}

func routeShapesHandler(w http.ResponseWriter, r *http.Request) {
	shapeID := r.URL.Query().Get("shape_id")
	if shapeID == "" {
		log.Println("routeShapes: missing shape_id param")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("{}"))
		return
	}
	log.Printf("routeShapes: loading shape_id=%s", shapeID)
	if shapesDir != "" {
		shapePath := filepath.Join(shapesDir, shapeID+".json")
		if _, err := os.Stat(shapePath); err == nil {
			log.Printf("routeShapes: serving pre-computed file for shape_id=%s", shapeID)
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "public, max-age=86400")
			http.ServeFile(w, r, shapePath)
			return
		}
	}
	log.Printf("routeShapes: pre-computed file not found, loading from cache/CSV for shape_id=%s", shapeID)
	coords, err := loadShapeForTrip(shapeID)
	if err != nil {
		log.Printf("routeShapes: error loading shape_id=%s: %v", shapeID, err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if coords == nil {
		coords = [][2]float64{}
	}
	payload, err := json.Marshal(coords)
	if err != nil {
		log.Printf("routeShapes: failed to encode shape_id=%s: %v", shapeID, err)
		http.Error(w, "failed to encode shape", http.StatusInternalServerError)
		return
	}
	log.Printf("routeShapes: returning %d points for shape_id=%s", len(coords), shapeID)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Write(payload)
}

func datafeedsGTFSIndexHandler(w http.ResponseWriter, r *http.Request) {
	if datafeedsFileMap == nil {
		http.Error(w, "datafeed file map not initialized", http.StatusInternalServerError)
		return
	}
	var names []string
	for name := range datafeedsFileMap {
		names = append(names, name)
	}
	sort.Strings(names)
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	if err := enc.Encode(names); err != nil {
		http.Error(w, "failed to write response", http.StatusInternalServerError)
		return
	}
}

func datafeedsGTFSFileHandler(w http.ResponseWriter, r *http.Request) {
	if datafeedsFileMap == nil {
		http.Error(w, "datafeed file map not initialized", http.StatusInternalServerError)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/datafeeds/")
	name = strings.TrimSpace(name)
	if name == "" {
		http.NotFound(w, r)
		return
	}
	if name == "zip" || strings.HasPrefix(name, "json") {
		http.NotFound(w, r)
		return
	}
	entry, ok := datafeedsFileMap[name]
	if !ok {
		http.NotFound(w, r)
		return
	}
	switch entry.ext {
	case ".txt", ".csv":
		if tripDataDir != "" {
			cachedPath := filepath.Join(tripDataDir, name+".json")
			if _, err := os.Stat(cachedPath); err == nil {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Cache-Control", "public, max-age=3600")
				http.ServeFile(w, r, cachedPath)
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		if err := streamCSVAsJSON(entry.path, w); err != nil {
			log.Printf("error streaming %s as json: %v", entry.path, err)
		}
	case ".md":
		content, err := os.ReadFile(entry.path)
		if err != nil {
			http.Error(w, "failed to read markdown", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		payload := map[string]string{"content": string(content)}
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		if err := enc.Encode(payload); err != nil {
			http.Error(w, "failed to write response", http.StatusInternalServerError)
			return
		}
	default:
		http.Error(w, "unsupported file type", http.StatusBadRequest)
	}
}

func downloadDatafeed(destination string) error {
	apiKey := os.Getenv("API_KEY")
	if apiKey == "" {
		return fmt.Errorf("API_KEY env var is not set")
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return fmt.Errorf("failed to create data directory: %w", err)
	}
	client := &http.Client{Timeout: 60 * time.Second}
	url := fmt.Sprintf("%s?api_key=%s&operator_id=%s", datafeedsBase, apiKey, operatorParam)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Accept", "application/zip")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to fetch datafeeds: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("upstream error: %s", string(body))
	}
	body, err := readResponseBody(resp)
	if err != nil {
		return fmt.Errorf("failed to read upstream response: %w", err)
	}
	if err := os.WriteFile(destination, body, 0o644); err != nil {
		return fmt.Errorf("failed to write datafeed file: %w", err)
	}
	return nil
}

func unzipDatafeed(zipPath, destination string) error {
	if err := os.RemoveAll(destination); err != nil {
		return fmt.Errorf("failed to clear destination: %w", err)
	}
	if err := os.MkdirAll(destination, 0o755); err != nil {
		return fmt.Errorf("failed to create destination: %w", err)
	}
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("failed to open zip: %w", err)
	}
	defer reader.Close()
	for _, file := range reader.File {
		if err := extractZipFile(file, destination); err != nil {
			return err
		}
	}
	return nil
}

func extractShapeFiles() error {
	entry, ok := datafeedsFileMap["shapes"]
	if !ok {
		return fmt.Errorf("shapes.txt not found in datafeed")
	}
	file, err := os.Open(entry.path)
	if err != nil {
		return fmt.Errorf("failed to open shapes.txt: %w", err)
	}
	defer file.Close()
	reader := csv.NewReader(file)
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	headers, err := reader.Read()
	if err != nil {
		return fmt.Errorf("failed to read shapes.txt headers: %w", err)
	}
	headerIndex := make(map[string]int)
	for i, h := range headers {
		headerIndex[h] = i
	}
	getField := func(record []string, field string) string {
		if idx, ok := headerIndex[field]; ok && idx < len(record) {
			return record[idx]
		}
		return ""
	}
	type shapePt struct {
		lat float64
		lon float64
		seq int
	}
	shapePoints := make(map[string][]shapePt)
	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			log.Printf("error reading shapes.txt during extraction: %v", err)
			continue
		}
		sid := getField(record, "shape_id")
		if sid == "" {
			continue
		}
		lat, _ := strconv.ParseFloat(getField(record, "shape_pt_lat"), 64)
		lon, _ := strconv.ParseFloat(getField(record, "shape_pt_lon"), 64)
		seq, _ := strconv.Atoi(getField(record, "shape_pt_sequence"))
		shapePoints[sid] = append(shapePoints[sid], shapePt{lat: lat, lon: lon, seq: seq})
	}
	if err := os.RemoveAll(shapesDir); err != nil {
		return fmt.Errorf("failed to clear shapes directory: %w", err)
	}
	if err := os.MkdirAll(shapesDir, 0o755); err != nil {
		return fmt.Errorf("failed to create shapes directory: %w", err)
	}
	var shapeIDs []string
	for sid, pts := range shapePoints {
		sort.Slice(pts, func(i, j int) bool {
			return pts[i].seq < pts[j].seq
		})
		coords := make([][2]float64, len(pts))
		for i, p := range pts {
			coords[i] = [2]float64{p.lat, p.lon}
		}
		payload, err := json.Marshal(coords)
		if err != nil {
			log.Printf("error marshaling shape %s: %v", sid, err)
			continue
		}
		if err := os.WriteFile(filepath.Join(shapesDir, sid+".json"), payload, 0o644); err != nil {
			log.Printf("error writing shape file %s.json: %v", sid, err)
			continue
		}
		shapeIDs = append(shapeIDs, sid)
	}
	indexPayload, _ := json.Marshal(shapeIDs)
	if err := os.WriteFile(filepath.Join(shapesDir, "index.json"), indexPayload, 0o644); err != nil {
		log.Printf("error writing shapes index: %v", err)
	}
	log.Printf("Extracted %d individual shape files to %s", len(shapeIDs), shapesDir)
	return nil
}

func getActiveTripIDs() []string {
	vehiclePositionsCacheMu.RLock()
	payload := vehiclePositionsCachePayload
	vehiclePositionsCacheMu.RUnlock()
	if payload == nil {
		return nil
	}
	var feed struct {
		Entity []struct {
			Vehicle *struct {
				Trip *struct {
					TripId string `json:"tripId"`
				} `json:"trip"`
			} `json:"vehicle"`
		} `json:"entity"`
	}
	if err := json.Unmarshal(payload, &feed); err != nil {
		log.Printf("failed to parse vehicle positions for active trips: %v", err)
		return nil
	}
	tripIDs := make([]string, 0, len(feed.Entity))
	seen := make(map[string]bool)
	for _, entity := range feed.Entity {
		if entity.Vehicle != nil && entity.Vehicle.Trip != nil && entity.Vehicle.Trip.TripId != "" {
			tid := entity.Vehicle.Trip.TripId
			if !seen[tid] {
				seen[tid] = true
				tripIDs = append(tripIDs, tid)
			}
		}
	}
	return tripIDs
}

func precomputeActiveTripDetails(activeTripIDs []string) {
	if len(activeTripIDs) == 0 {
		log.Println("No active trips to precompute")
		return
	}
	log.Printf("Pre-computing trip details for %d active trips...", len(activeTripIDs))
	trips := loadTripsData()
	stops := loadStopsData()
	var needsStopTimes bool
	var sampleTripID string
	for _, tid := range activeTripIDs {
		if _, ok := trips[tid]; ok {
			needsStopTimes = true
			break
		}
		if sampleTripID == "" {
			sampleTripID = tid
		}
	}
	if !needsStopTimes {
		var tripSample string
		for tid := range trips {
			tripSample = tid
			break
		}
		log.Printf("Active trip IDs don't match GTFS trips data (vehicle example: %q, trips.txt example: %q), skipping pre-computation", sampleTripID, tripSample)
		return
	}
	_ = loadStopTimesForTrip(activeTripIDs[0])
	if err := os.MkdirAll(tripDetailsDir, 0o755); err != nil {
		log.Printf("failed to create trip details directory: %v", err)
		return
	}
	count := 0
	for _, tid := range activeTripIDs {
		trip, ok := trips[tid]
		if !ok {
			continue
		}
		times := loadStopTimesForTrip(tid)
		schedule := make([]map[string]interface{}, 0, len(times))
		for _, st := range times {
			stop := stops[st.stop_id]
			entry := map[string]interface{}{
				"stop_id":        st.stop_id,
				"stop_sequence":  st.stop_sequence,
				"arrival_time":   st.arrival_time,
				"departure_time": st.departure_time,
				"stop_name":      stop.stop_name,
				"stop_lat":       stop.stop_lat,
				"stop_lon":       stop.stop_lon,
			}
			schedule = append(schedule, entry)
		}
		result := map[string]interface{}{
			"trip_id":         trip.trip_id,
			"route_id":        trip.route_id,
			"service_id":      trip.service_id,
			"trip_headsign":   trip.trip_headsign,
			"direction_id":    trip.direction_id,
			"shape_id":        trip.shape_id,
			"block_id":        trip.block_id,
			"trip_short_name": trip.trip_short_name,
			"schedule":        schedule,
		}
		payload, err := json.Marshal(result)
		if err != nil {
			log.Printf("error marshaling trip detail %s: %v", tid, err)
			continue
		}
		if err := os.WriteFile(filepath.Join(tripDetailsDir, tid+".json"), payload, 0o644); err != nil {
			log.Printf("error writing trip detail file %s.json: %v", tid, err)
			continue
		}
		count++
	}
	log.Printf("Pre-computed trip details for %d active trips", count)
}

func cacheDatafeedJSON(name string) error {
	entry, ok := datafeedsFileMap[name]
	if !ok {
		return fmt.Errorf("%s not found in datafeed", name)
	}
	if err := os.MkdirAll(tripDataDir, 0o755); err != nil {
		return fmt.Errorf("failed to create tripdata directory: %w", err)
	}
	outPath := filepath.Join(tripDataDir, name+".json")
	tmpPath := outPath + ".tmp"
	out, err := os.Create(tmpPath)
	if err != nil {
		return fmt.Errorf("failed to create %s.json.tmp: %w", name, err)
	}
	if err := streamCSVAsJSON(entry.path, out); err != nil {
		out.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("failed to stream %s as json: %w", name, err)
	}
	out.Close()
	if err := os.Rename(tmpPath, outPath); err != nil {
		return fmt.Errorf("failed to rename %s.json: %w", name, err)
	}
	log.Printf("Pre-computed %s.json (size: %d bytes)", name, func() int64 {
		fi, _ := os.Stat(outPath)
		if fi != nil {
			return fi.Size()
		}
		return 0
	}())
	return nil
}

func extractZipFile(file *zip.File, destination string) error {
	cleanName := filepath.Clean(file.Name)
	if strings.HasPrefix(cleanName, "..") {
		return fmt.Errorf("invalid zip entry: %s", file.Name)
	}
	fullPath := filepath.Join(destination, cleanName)
	if !isSubpath(destination, fullPath) {
		return fmt.Errorf("invalid zip entry path: %s", file.Name)
	}
	if file.FileInfo().IsDir() {
		if err := os.MkdirAll(fullPath, file.Mode()); err != nil {
			return fmt.Errorf("failed to create directory: %w", err)
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}
	src, err := file.Open()
	if err != nil {
		return fmt.Errorf("failed to open zip entry: %w", err)
	}
	defer src.Close()
	dst, err := os.OpenFile(fullPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, file.Mode())
	if err != nil {
		return fmt.Errorf("failed to create file: %w", err)
	}
	defer dst.Close()
	if _, err := io.Copy(dst, src); err != nil {
		return fmt.Errorf("failed to write file: %w", err)
	}
	return nil
}

func indexJSONFiles(root string) ([]string, error) {
	var files []string
	if err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if strings.HasSuffix(strings.ToLower(d.Name()), ".json") {
			rel, relErr := filepath.Rel(root, path)
			if relErr != nil {
				return relErr
			}
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return files, nil
}

func indexDatafeedFiles(root string) ([]string, error) {
	var files []string
	if err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return relErr
		}
		files = append(files, filepath.ToSlash(rel))
		return nil
	}); err != nil {
		return nil, err
	}
	return files, nil
}

type datafeedEntry struct {
	path string
	ext  string
}

func buildDatafeedFileMap(root string) (map[string]datafeedEntry, error) {
	files, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	fileMap := make(map[string]datafeedEntry)
	for _, entry := range files {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		ext := strings.ToLower(filepath.Ext(name))
		if ext != ".txt" && ext != ".csv" && ext != ".md" {
			continue
		}
		base := strings.TrimSuffix(name, ext)
		if _, exists := fileMap[base]; exists {
			continue
		}
		fileMap[base] = datafeedEntry{path: filepath.Join(root, name), ext: ext}
	}
	return fileMap, nil
}

func streamCSVAsJSON(path string, w io.Writer) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	reader := csv.NewReader(file)
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	headers, err := reader.Read()
	if err != nil {
		return err
	}
	if _, err := w.Write([]byte("[")); err != nil {
		return err
	}
	first := true
	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		row := make(map[string]string, len(headers))
		for i, header := range headers {
			if i < len(record) {
				row[header] = record[i]
			} else {
				row[header] = ""
			}
		}
		payload, err := json.Marshal(row)
		if err != nil {
			return err
		}
		if !first {
			if _, err := w.Write([]byte(",")); err != nil {
				return err
			}
		}
		first = false
		if _, err := w.Write(payload); err != nil {
			return err
		}
	}
	if _, err := w.Write([]byte("]")); err != nil {
		return err
	}
	return nil
}

func isSubpath(basePath, targetPath string) bool {
	rel, err := filepath.Rel(basePath, targetPath)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func readResponseBody(resp *http.Response) ([]byte, error) {
	encoding := strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Encoding")))
	switch encoding {
	case "", "identity":
		return io.ReadAll(resp.Body)
	case "gzip":
		reader, err := gzip.NewReader(resp.Body)
		if err != nil {
			return nil, err
		}
		defer reader.Close()
		return io.ReadAll(reader)
	case "deflate":
		reader, err := zlib.NewReader(resp.Body)
		if err != nil {
			return nil, err
		}
		defer reader.Close()
		return io.ReadAll(reader)
	default:
		return nil, fmt.Errorf("unsupported content-encoding: %s", encoding)
	}
}

func refreshDatafeeds() error {
	if err := downloadDatafeed(datafeedsFilePath); err != nil {
		return fmt.Errorf("failed to download datafeed: %w", err)
	}
	if err := unzipDatafeed(datafeedsFilePath, datafeedsDir); err != nil {
		return fmt.Errorf("failed to unzip datafeed: %w", err)
	}
	stopTimesData.Store(nil)
	tripsData.Store(nil)
	stopsData.Store(nil)
	routesData.Store(nil)
	stopGroupsCache.Store(nil)
	routeFirstTripOnce = sync.Once{}
	routeFirstTrip = nil
	invalidateTripsCache()
	routeShapesCacheMu.Lock()
	routeShapesCache = nil
	routeShapesCacheMu.Unlock()
	shapesCacheMu.Lock()
	shapesCache = nil
	shapesOnce = sync.Once{}
	shapesCacheMu.Unlock()
	jsonFiles, err := indexJSONFiles(datafeedsDir)
	if err != nil {
		return fmt.Errorf("failed to index json files: %w", err)
	}
	files, err := indexDatafeedFiles(datafeedsDir)
	if err != nil {
		return fmt.Errorf("failed to index datafeed files: %w", err)
	}
	fileMap, err := buildDatafeedFileMap(datafeedsDir)
	if err != nil {
		return fmt.Errorf("failed to build datafeed file map: %w", err)
	}
	datafeedsJSONFiles = jsonFiles
	datafeedsFiles = files
	datafeedsFileMap = fileMap
	if err := extractShapeFiles(); err != nil {
		log.Printf("failed to extract individual shape files: %v", err)
	}
	if activeTripIDs := getActiveTripIDs(); len(activeTripIDs) > 0 {
		log.Printf("Pre-computing trip details for %d active vehicles", len(activeTripIDs))
		precomputeActiveTripDetails(activeTripIDs)
	} else {
		log.Println("No active vehicle positions for trip pre-computation (511 API may be down or no vehicles active)")
	}
	for _, table := range []string{"agency", "routes", "stops", "trips"} {
		if err := cacheDatafeedJSON(table); err != nil {
			log.Printf("failed to pre-compute %s.json: %v", table, err)
		}
	}
	log.Println("Warming in-memory data caches...")
	loadTripsData()
	loadStopsData()
	log.Println("In-memory caches warmed")
	return nil
}

type TripInfo struct {
	trip_id               string
	route_id              string
	service_id            string
	trip_headsign         string
	direction_id          string
	shape_id              string
	block_id              string
	trip_short_name       string
	wheelchair_accessible string
	bikes_allowed         string
	trip_start_time       string
	trip_end_time         string
}
type StopTimeInfo struct {
	trip_id        string
	arrival_time   string
	departure_time string
	stop_id        string
	stop_sequence  int
}
type VehicleTypeInfo struct {
	Year     int    `json:"year"`
	Make     string `json:"make"`
	Model    string `json:"model"`
	Fuel     string `json:"fuel"`
	Length   int    `json:"length"`
	IconCode string `json:"icon_code"`
}
type VehicleTypeRange struct {
	Start string          `json:"start"`
	End   string          `json:"end"`
	Type  VehicleTypeInfo `json:"-"`
}
type AgencyVehicleMap struct {
	Ranges []struct {
		Start string `json:"start"`
		End   string `json:"end"`
		VehicleTypeInfo
	} `json:"ranges"`
	Exact map[string]VehicleTypeInfo `json:"exact"`
}
type VehicleTypeConfig struct {
	Agencies map[string]AgencyVehicleMap `json:"agencies"`
}

var (
	vehicleTypeConfig  *VehicleTypeConfig
	vehicleTypeOnce    sync.Once
	vehicleTypeCacheMu sync.RWMutex
)

func loadVehicleTypeConfig() *VehicleTypeConfig {
	vehicleTypeOnce.Do(func() {
		filePath := vehicleTypesFilePath
		if _, err := os.Stat(filePath); os.IsNotExist(err) {
			log.Println("vehicle_types.json not found, vehicle type enrichment disabled")
			vehicleTypeConfig = &VehicleTypeConfig{Agencies: make(map[string]AgencyVehicleMap)}
			return
		}
		data, err := os.ReadFile(filePath)
		if err != nil {
			log.Printf("failed to read vehicle_types.json: %v", err)
			vehicleTypeConfig = &VehicleTypeConfig{Agencies: make(map[string]AgencyVehicleMap)}
			return
		}
		var config VehicleTypeConfig
		if err := json.Unmarshal(data, &config); err != nil {
			log.Printf("failed to parse vehicle_types.json: %v", err)
			vehicleTypeConfig = &VehicleTypeConfig{Agencies: make(map[string]AgencyVehicleMap)}
			return
		}
		vehicleTypeConfig = &config
		log.Printf("Loaded vehicle types for %d agencies", len(config.Agencies))
	})
	return vehicleTypeConfig
}

// enrichVehicleType sets vehicle make/model/year/fuel fields for a fixed
// agency code. Used by sacrt/elk, whose realtime IDs carry no agency prefix.
func enrichVehicleType(vehicle map[string]interface{}, agencyCode string) {
	vehObj, ok := vehicle["vehicle"].(map[string]interface{})
	if !ok {
		return
	}
	vehicleID, _ := vehObj["id"].(string)
	if vehicleID == "" {
		return
	}
	if vti := lookupVehicleType(agencyCode, vehicleID); vti != nil {
		vehicle["vehicleYear"] = vti.Year
		vehicle["vehicleMake"] = vti.Make
		vehicle["vehicleModel"] = vti.Model
		vehicle["vehicleFuel"] = vti.Fuel
		vehicle["vehicleLength"] = vti.Length
		vehicle["vehicleIconCode"] = vti.IconCode
	}
}

func lookupVehicleType(agencyCode, vehicleID string) *VehicleTypeInfo {
	config := loadVehicleTypeConfig()
	if config == nil {
		return nil
	}
	agencyMap, ok := config.Agencies[agencyCode]
	if !ok {
		return nil
	}
	if exact, ok := agencyMap.Exact[vehicleID]; ok {
		return &exact
	}
	for _, r := range agencyMap.Ranges {
		if vehicleID >= r.Start && vehicleID <= r.End {
			return &VehicleTypeInfo{
				Year:     r.Year,
				Make:     r.Make,
				Model:    r.Model,
				Fuel:     r.Fuel,
				Length:   r.Length,
				IconCode: r.IconCode,
			}
		}
	}
	return nil
}

type StopInfo struct {
	stop_id        string
	stop_name      string
	stop_lat       string
	stop_lon       string
	parent_station string
}
type StopGroup struct {
	GroupID string
	Name    string
	Lat     float64
	Lon     float64
	Members []string
	RouteID string
}
type BlockScheduleEntry struct {
	TripID               string `json:"trip_id"`
	RouteID              string `json:"route_id"`
	RouteShortName       string `json:"route_short_name"`
	RouteLongName        string `json:"route_long_name"`
	DirectionID          string `json:"direction_id"`
	StartTime            string `json:"start_time"`
	EndTime              string `json:"end_time"`
	HeadSign             string `json:"headsign"`
	StartStopName        string `json:"start_stop_name"`
	EndStopName          string `json:"end_stop_name"`
	ShapeID              string `json:"shape_id"`
	WheelchairAccessible string `json:"wheelchair_accessible"`
	BikesAllowed         string `json:"bikes_allowed"`
}

var (
	tripsData          atomic.Pointer[map[string]TripInfo]
	tripsDataMu        sync.Mutex
	stopsData          atomic.Pointer[map[string]StopInfo]
	stopsDataMu        sync.Mutex
	routesData         atomic.Pointer[map[string]RouteInfo]
	routesDataMu       sync.Mutex
	stopTimesData      atomic.Pointer[map[string][]StopTimeInfo]
	stopTimesDataMu    sync.Mutex
	routeFirstTrip     map[string]string
	routeFirstTripOnce sync.Once
)

func firstTripOnRoute(routeID string) string {
	routeFirstTripOnce.Do(func() {
		m := make(map[string]string)
		for _, t := range loadTripsData() {
			if _, ok := m[t.route_id]; !ok {
				m[t.route_id] = t.trip_id
			}
		}
		routeFirstTrip = m
	})
	return routeFirstTrip[routeID]
}

type RouteInfo struct {
	shortName string
	longName  string
}

func loadTripsData() map[string]TripInfo {
	if m := tripsData.Load(); m != nil {
		return *m
	}
	tripsDataMu.Lock()
	defer tripsDataMu.Unlock()
	if m := tripsData.Load(); m != nil {
		return *m
	}
	trips := make(map[string]TripInfo)
	filePath := filepath.Join(datafeedsDir, "trips.txt")
	if _, err := os.Stat(filePath); err == nil {
		file, err := os.Open(filePath)
		if err == nil {
			defer file.Close()
			reader := csv.NewReader(file)
			reader.FieldsPerRecord = -1
			reader.LazyQuotes = true
			headers, _ := reader.Read()
			headerMap := make(map[string]int)
			for i, h := range headers {
				headerMap[h] = i
			}
			for {
				record, err := reader.Read()
				if err == io.EOF {
					break
				}
				if err != nil {
					continue
				}
				get := func(field string) string {
					if idx, ok := headerMap[field]; ok && idx < len(record) {
						return record[idx]
					}
					return ""
				}
				trip := TripInfo{
					trip_id:               get("trip_id"),
					route_id:              get("route_id"),
					service_id:            get("service_id"),
					trip_headsign:         get("trip_headsign"),
					direction_id:          get("direction_id"),
					shape_id:              get("shape_id"),
					block_id:              get("block_id"),
					trip_short_name:       get("trip_short_name"),
					wheelchair_accessible: get("wheelchair_accessible"),
					bikes_allowed:         get("bikes_allowed"),
					trip_start_time:       "",
					trip_end_time:         "",
				}
				if trip.trip_id != "" {
					trips[trip.trip_id] = trip
				}
			}
		}
	}
	_ = loadStopTimesForTrip("")
	if stm := stopTimesData.Load(); stm != nil {
		for tid, times := range *stm {
			if len(times) > 0 {
				if trip, ok := trips[tid]; ok {
					trip.trip_start_time = times[0].departure_time
					trip.trip_end_time = times[len(times)-1].arrival_time
					trips[tid] = trip
				}
			}
		}
		log.Printf("Updated trips with start/end times from stop_times cache")
	}
	tripsData.Store(&trips)
	return trips
}

func loadStopTimesForTrip(tripID string) []StopTimeInfo {
	if m := stopTimesData.Load(); m != nil {
		return (*m)[tripID]
	}
	stopTimesDataMu.Lock()
	defer stopTimesDataMu.Unlock()
	if m := stopTimesData.Load(); m != nil {
		return (*m)[tripID]
	}
	st := make(map[string][]StopTimeInfo)
	filePath := filepath.Join(datafeedsDir, "stop_times.txt")
	if _, err := os.Stat(filePath); err != nil {
		stopTimesData.Store(&st)
		return st[tripID]
	}
	file, err := os.Open(filePath)
	if err != nil {
		log.Printf("failed to open stop_times.txt: %v", err)
		stopTimesData.Store(&st)
		return st[tripID]
	}
	defer file.Close()
	reader := csv.NewReader(file)
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	headers, err := reader.Read()
	if err != nil {
		log.Printf("failed to read stop_times.txt headers: %v", err)
		stopTimesData.Store(&st)
		return st[tripID]
	}
	headerMap := make(map[string]int)
	for i, h := range headers {
		headerMap[h] = i
	}
	get := func(field string, rec []string) string {
		if idx, ok := headerMap[field]; ok && idx < len(rec) {
			return rec[idx]
		}
		return ""
	}
	for {
		var rec []string
		var err error
		func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("panic reading stop_times.csv: %v", r)
					err = fmt.Errorf("panic: %v", r)
				}
			}()
			rec, err = reader.Read()
		}()
		if err == io.EOF {
			break
		}
		if err != nil {
			continue
		}
		tid := get("trip_id", rec)
		if tid == "" {
			continue
		}
		seq := 0
		if s := get("stop_sequence", rec); s != "" {
			fmt.Sscanf(s, "%d", &seq)
		}
		st[tid] = append(st[tid], StopTimeInfo{
			trip_id:        tid,
			arrival_time:   get("arrival_time", rec),
			departure_time: get("departure_time", rec),
			stop_id:        get("stop_id", rec),
			stop_sequence:  seq,
		})
	}
	log.Printf("Loaded %d stop_times entries for %d trips", len(st), len(st))
	stopTimesData.Store(&st)
	return st[tripID]
}

func loadStopsData() map[string]StopInfo {
	if m := stopsData.Load(); m != nil {
		return *m
	}
	stopsDataMu.Lock()
	defer stopsDataMu.Unlock()
	if m := stopsData.Load(); m != nil {
		return *m
	}
	stops := make(map[string]StopInfo)
	filePath := filepath.Join(datafeedsDir, "stops.txt")
	if _, err := os.Stat(filePath); err == nil {
		file, err := os.Open(filePath)
		if err == nil {
			defer file.Close()
			reader := csv.NewReader(file)
			reader.FieldsPerRecord = -1
			reader.LazyQuotes = true
			headers, _ := reader.Read()
			headerMap := make(map[string]int)
			for i, h := range headers {
				headerMap[h] = i
			}
			for {
				record, err := reader.Read()
				if err == io.EOF {
					break
				}
				if err != nil {
					continue
				}
				get := func(field string) string {
					if idx, ok := headerMap[field]; ok && idx < len(record) {
						return record[idx]
					}
					return ""
				}
				stop := StopInfo{
					stop_id:        get("stop_id"),
					stop_name:      get("stop_name"),
					stop_lat:       get("stop_lat"),
					stop_lon:       get("stop_lon"),
					parent_station: get("parent_station"),
				}
				if stop.stop_id != "" {
					stops[stop.stop_id] = stop
				}
			}
		}
	}
	stopsData.Store(&stops)
	return stops
}

var (
	stopGroupsCache   atomic.Pointer[map[string]StopGroup]
	stopGroupsCacheMu sync.Mutex
)

func loadStopGroups() map[string]StopGroup {
	if g := stopGroupsCache.Load(); g != nil {
		return *g
	}
	stopGroupsCacheMu.Lock()
	defer stopGroupsCacheMu.Unlock()
	if g := stopGroupsCache.Load(); g != nil {
		return *g
	}
	stops := loadStopsData()
	members := make(map[string][]string)
	for _, s := range stops {
		key := s.stop_id
		if p := s.parent_station; p != "" {
			if _, ok := stops[p]; ok {
				key = p
			}
		}
		members[key] = append(members[key], s.stop_id)
	}
	loadStopTimesForTrip("")
	trips := loadTripsData()
	routesPerStop := make(map[string]map[string]bool)
	if m := stopTimesData.Load(); m != nil {
		for tripID, times := range *m {
			trip, ok := trips[tripID]
			if !ok || trip.route_id == "" {
				continue
			}
			for _, st := range times {
				rset := routesPerStop[st.stop_id]
				if rset == nil {
					rset = make(map[string]bool)
					routesPerStop[st.stop_id] = rset
				}
				rset[trip.route_id] = true
			}
		}
	}
	groups := make([]StopGroup, 0, len(members))
	for key, ids := range members {
		var routes []string
		for _, id := range ids {
			for rid := range routesPerStop[id] {
				routes = append(routes, rid)
			}
		}
		if len(routes) == 0 {
			continue
		}
		sort.Strings(ids)
		sort.Strings(routes)
		rep := stops[key]
		lat, _ := strconv.ParseFloat(rep.stop_lat, 64)
		lon, _ := strconv.ParseFloat(rep.stop_lon, 64)
		groups = append(groups, StopGroup{
			GroupID: key,
			Name:    rep.stop_name,
			Lat:     lat,
			Lon:     lon,
			Members: ids,
			RouteID: routes[0],
		})
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i].GroupID < groups[j].GroupID })
	groups = mergeNearbyStops(groups)
	byID := make(map[string]StopGroup, len(groups))
	for _, g := range groups {
		byID[g.GroupID] = g
	}
	log.Printf("Loaded %d stop groups", len(byID))
	stopGroupsCache.Store(&byID)
	return byID
}

const stopMergeRadiusFeet = 500

func mergeNearbyStops(groups []StopGroup) []StopGroup {
	cellDeg := (stopMergeRadiusFeet * 0.3048) / 111320.0
	cell := func(lat, lon float64) [2]int {
		return [2]int{int(math.Floor(lat / cellDeg)), int(math.Floor(lon / cellDeg))}
	}
	grid := make(map[[2]int][]int)
	for i, g := range groups {
		c := cell(g.Lat, g.Lon)
		grid[c] = append(grid[c], i)
	}
	absorbedInto := make([]int, len(groups))
	for i := range absorbedInto {
		absorbedInto[i] = -1
	}
	rootOf := func(i int) int {
		for absorbedInto[i] >= 0 {
			i = absorbedInto[i]
		}
		return i
	}
	for i := range groups {
		root := rootOf(i)
		if root != i {
			continue
		}
		queue := []int{i}
		for len(queue) > 0 {
			idx := queue[0]
			queue = queue[1:]
			cur := groups[idx]
			base := cell(cur.Lat, cur.Lon)
			for dx := -1; dx <= 1; dx++ {
				for dy := -1; dy <= 1; dy++ {
					for _, j := range grid[[2]int{base[0] + dx, base[1] + dy}] {
						if rootOf(j) == root {
							continue
						}
						if groups[j].Name == cur.Name &&
							stopDistFeet(cur.Lat, cur.Lon, groups[j].Lat, groups[j].Lon) <= stopMergeRadiusFeet {
							absorbedInto[j] = root
							queue = append(queue, j)
						}
					}
				}
			}
		}
	}
	type fold struct {
		g       StopGroup
		members map[string]bool
		route   string
	}
	folds := make([]fold, len(groups))
	for i := range groups {
		folds[i] = fold{g: groups[i], members: map[string]bool{}, route: groups[i].RouteID}
		folds[i].members[groups[i].GroupID] = true
	}
	out := make([]StopGroup, 0, len(groups))
	for i := range groups {
		if rootOf(i) != i {
			continue
		}
		f := folds[i]
		for j := range groups {
			if j != i && rootOf(j) == i {
				for id := range folds[j].members {
					f.members[id] = true
				}
				if folds[j].route != "" && (f.route == "" || folds[j].route < f.route) {
					f.route = folds[j].route
				}
			}
		}
		members := make([]string, 0, len(f.members))
		for id := range f.members {
			members = append(members, id)
		}
		sort.Strings(members)
		g := f.g
		g.Members = members
		g.RouteID = f.route
		out = append(out, g)
	}
	return out
}

func stopDistFeet(aLat, aLon, bLat, bLon float64) float64 {
	const metersPerDeg = 111320.0
	dLat := (bLat - aLat) * metersPerDeg
	dLon := (bLon - aLon) * metersPerDeg * math.Cos(aLat*math.Pi/180)
	return math.Sqrt(dLat*dLat+dLon*dLon) / 0.3048
}

func loadRoutesData() map[string]RouteInfo {
	if m := routesData.Load(); m != nil {
		return *m
	}
	routesDataMu.Lock()
	defer routesDataMu.Unlock()
	if m := routesData.Load(); m != nil {
		return *m
	}
	routes := make(map[string]RouteInfo)
	filePath := filepath.Join(datafeedsDir, "routes.txt")
	if _, err := os.Stat(filePath); err == nil {
		file, err := os.Open(filePath)
		if err == nil {
			defer file.Close()
			reader := csv.NewReader(file)
			reader.FieldsPerRecord = -1
			reader.LazyQuotes = true
			headers, _ := reader.Read()
			headerMap := make(map[string]int)
			for i, h := range headers {
				headerMap[h] = i
			}
			for {
				record, err := reader.Read()
				if err == io.EOF {
					break
				}
				if err != nil {
					continue
				}
				get := func(field string) string {
					if idx, ok := headerMap[field]; ok && idx < len(record) {
						return record[idx]
					}
					return ""
				}
				routeID := get("route_id")
				routeShortName := get("route_short_name")
				routeLongName := get("route_long_name")
				if routeID != "" && routeShortName != "" {
					routes[routeID] = RouteInfo{shortName: routeShortName, longName: routeLongName}
				}
			}
		}
	}
	routesData.Store(&routes)
	return routes
}

func getRouteShortName(routeID string) string {
	routes := loadRoutesData()
	if route, ok := routes[routeID]; ok {
		return route.shortName
	}
	if idx := strings.LastIndex(routeID, ":"); idx >= 0 {
		return routeID[idx+1:]
	}
	return routeID
}

func getRouteLongName(routeID string) string {
	routes := loadRoutesData()
	if route, ok := routes[routeID]; ok {
		return route.longName
	}
	if idx := strings.LastIndex(routeID, ":"); idx >= 0 {
		return routeID[idx+1:]
	}
	return routeID
}

func scanCSVRows(path string, fn func(map[string]string)) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()
	reader := csv.NewReader(file)
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	headers, err := reader.Read()
	if err != nil {
		return
	}
	for {
		record, err := reader.Read()
		if err != nil {
			return
		}
		rec := make(map[string]string, len(headers))
		for i, h := range headers {
			if i < len(record) {
				rec[h] = record[i]
			}
		}
		fn(rec)
	}
}

func loadAgencyTimezone() *time.Location {
	var tz string
	scanCSVRows(filepath.Join(datafeedsDir, "agency.txt"), func(rec map[string]string) {
		if tz == "" && rec["agency_timezone"] != "" {
			tz = rec["agency_timezone"]
		}
	})
	if loc, err := time.LoadLocation(tz); err == nil {
		return loc
	}
	return time.UTC
}

func todaysServiceIDs(day time.Time) map[string]bool {
	active := make(map[string]bool)
	date := day.Format("20060102")
	weekday := []string{"sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"}[int(day.Weekday())]
	scanCSVRows(filepath.Join(datafeedsDir, "calendar.txt"), func(rec map[string]string) {
		if date >= rec["start_date"] && date <= rec["end_date"] && rec[weekday] == "1" {
			active[rec["service_id"]] = true
		}
	})
	scanCSVRows(filepath.Join(datafeedsDir, "calendar_dates.txt"), func(rec map[string]string) {
		if rec["date"] == date {
			if rec["exception_type"] == "1" {
				active[rec["service_id"]] = true
			} else {
				delete(active, rec["service_id"])
			}
		}
	})
	return active
}

func parseGTFSSeconds(t string) int {
	var h, m, s int
	fmt.Sscanf(t, "%d:%d:%d", &h, &m, &s)
	return h*3600 + m*60 + s
}

func stopDepartures(stopIDs map[string]bool, limit int) []map[string]interface{} {
	now := time.Now().In(loadAgencyTimezone())
	nowSecs := now.Unix()
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).Unix()
	yesterday := now.AddDate(0, 0, -1)
	yesterdayStart := time.Date(yesterday.Year(), yesterday.Month(), yesterday.Day(), 0, 0, 0, 0, yesterday.Location()).Unix()
	todayServices := todaysServiceIDs(now)
	yesterdayServices := todaysServiceIDs(yesterday)
	trips := loadTripsData()
	loadStopTimesForTrip("")
	m := stopTimesData.Load()
	if m == nil {
		return []map[string]interface{}{}
	}
	type dep struct {
		abs  int64
		st   StopTimeInfo
		trip TripInfo
	}
	var deps []dep
	for tripID, times := range *m {
		trip, ok := trips[tripID]
		if !ok {
			continue
		}
		for _, st := range times {
			if !stopIDs[st.stop_id] || st.departure_time == "" {
				continue
			}
			var abs int64
			switch {
			case todayServices[trip.service_id]:
				abs = todayStart + int64(parseGTFSSeconds(st.departure_time))
			case yesterdayServices[trip.service_id]:
				abs = yesterdayStart + int64(parseGTFSSeconds(st.departure_time))
			default:
				continue
			}
			abs = bayAreaTripUpdates.adjustedDeparture(trip.trip_id, st.stop_id, abs)
			if abs >= nowSecs {
				deps = append(deps, dep{abs: abs, st: st, trip: trip})
			}
		}
	}
	sort.Slice(deps, func(i, j int) bool { return deps[i].abs < deps[j].abs })
	seen := make(map[string]bool, len(deps))
	deduped := deps[:0]
	for _, d := range deps {
		key := d.st.trip_id + "|" + strconv.FormatInt(d.abs, 10)
		if seen[key] {
			continue
		}
		seen[key] = true
		deduped = append(deduped, d)
	}
	deps = deduped
	if len(deps) > limit {
		deps = deps[:limit]
	}
	out := make([]map[string]interface{}, 0, len(deps))
	for _, d := range deps {
		out = append(out, map[string]interface{}{
			"trip_id":             d.st.trip_id,
			"route_id":            d.trip.route_id,
			"route_short_name":    getRouteShortName(d.trip.route_id),
			"trip_headsign":       d.trip.trip_headsign,
			"direction_id":        d.trip.direction_id,
			"arrival_time":        d.st.arrival_time,
			"departure_time":      d.st.departure_time,
			"departure_timestamp": d.abs,
		})
	}
	return out
}

func vehicleTypesHandler(w http.ResponseWriter, r *http.Request) {
	config := loadVehicleTypeConfig()
	if config == nil {
		http.Error(w, "vehicle types not loaded", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	if err := enc.Encode(config); err != nil {
		http.Error(w, "failed to encode response", http.StatusInternalServerError)
		return
	}
}

func runDatafeedsRefresher() {
	ticker := time.NewTicker(datafeedsRefreshInterval)
	defer ticker.Stop()
	for range ticker.C {
		if err := refreshDatafeeds(); err != nil {
			log.Printf("datafeeds refresh failed: %v", err)
		}
	}
}
