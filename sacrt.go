package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"

	gtfs "github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

const (
	sacrtGTFSURL     = "https://apps.sacrt.com/gtfs/srtd/google_transit.zip"
	sacrtVehiclesURL = "https://bustime.sacrt.com/gtfsrt/vehicles"
	sacrtTripsURL    = "https://bustime.sacrt.com/gtfsrt/trips"
)

var sacrt = newSacrtRegion()

type sacrtRegion struct {
	dir             string
	gtfsZip         string
	gtfsDir         string
	tripDataDir     string
	shapesDir       string
	positionsFile   string
	refreshInterval time.Duration

	positionsMu      sync.RWMutex
	positionsPayload []byte
	positionsParsed  interface{}
	positionsTime    time.Time
	positionsErr     error

	trips        atomicPtr[map[string]TripInfo]
	tripsMu      sync.Mutex
	stops        atomicPtr[map[string]StopInfo]
	stopsMu      sync.Mutex
	routes       atomicPtr[map[string]RouteInfo]
	routesMu     sync.Mutex
	stopTimes    atomicPtr[map[string][]StopTimeInfo]
	stopTimesMu  sync.Mutex
	stopGroups   atomicPtr[map[string]StopGroup]
	stopGroupsMu sync.Mutex

	tripUpdates tripUpdateStore

	shapesCache   map[string][][2]float64
	shapesOnce    sync.Once
	shapesCacheMu sync.RWMutex
}

func newSacrtRegion() *sacrtRegion {
	work, _ := os.Getwd()
	return &sacrtRegion{
		dir:             filepath.Join(work, "data", "sacrt"),
		refreshInterval: time.Minute,
	}
}

func (r *sacrtRegion) initDirs() {
	r.gtfsZip = filepath.Join(r.dir, "gtfs.zip")
	r.gtfsDir = filepath.Join(r.dir, "gtfs")
	r.tripDataDir = filepath.Join(r.dir, "tripdata")
	r.shapesDir = filepath.Join(r.dir, "shapes")
	r.positionsFile = filepath.Join(r.dir, "vehicle_positions.json")
}

// ---- static GTFS ----

func (r *sacrtRegion) loadStatic() error {
	if err := downloadStaticGTFS(sacrtGTFSURL, r.gtfsZip, "", ""); err != nil {
		return err
	}
	return unzipDatafeed(r.gtfsZip, r.gtfsDir)
}

func (r *sacrtRegion) loadTrips() map[string]TripInfo {
	if m := r.trips.load(); m != nil {
		return *m
	}
	r.tripsMu.Lock()
	defer r.tripsMu.Unlock()
	if m := r.trips.load(); m != nil {
		return *m
	}
	trips := map[string]TripInfo{}
	scanCSVRows(filepath.Join(r.gtfsDir, "trips.txt"), func(rec map[string]string) {
		id := rec["trip_id"]
		if id == "" {
			return
		}
		trips[id] = TripInfo{
			trip_id:               id,
			route_id:              rec["route_id"],
			service_id:            rec["service_id"],
			trip_headsign:         rec["trip_headsign"],
			direction_id:          rec["direction_id"],
			shape_id:              rec["shape_id"],
			block_id:              rec["block_id"],
			trip_short_name:       rec["trip_short_name"],
			wheelchair_accessible: rec["wheelchair_accessible"],
			bikes_allowed:         rec["bikes_allowed"],
		}
	})
	r._fillTripTimes(trips)
	if len(trips) == 0 {
		return trips
	}
	r.trips.store(&trips)
	return trips
}

func (r *sacrtRegion) _fillTripTimes(trips map[string]TripInfo) {
	for tid, times := range r.loadStopTimesRaw() {
		if len(times) == 0 {
			continue
		}
		if t, ok := trips[tid]; ok {
			t.trip_start_time = gtfsTimeString(times[0].departure_time)
			t.trip_end_time = gtfsTimeString(times[len(times)-1].arrival_time)
			trips[tid] = t
		}
	}
}

func (r *sacrtRegion) loadStopTimesRaw() map[string][]StopTimeInfo {
	if m := r.stopTimes.load(); m != nil {
		return *m
	}
	r.stopTimesMu.Lock()
	defer r.stopTimesMu.Unlock()
	if m := r.stopTimes.load(); m != nil {
		return *m
	}
	st := map[string][]StopTimeInfo{}
	scanCSVRows(filepath.Join(r.gtfsDir, "stop_times.txt"), func(rec map[string]string) {
		tid := rec["trip_id"]
		if tid == "" {
			return
		}
		seq := 0
		if rec["stop_sequence"] != "" {
			seq, _ = strconv.Atoi(rec["stop_sequence"])
		}
		st[tid] = append(st[tid], StopTimeInfo{
			arrival_time:   gtfsSeconds(rec["arrival_time"]),
			departure_time: gtfsSeconds(rec["departure_time"]),
			stop_id:        rec["stop_id"],
			stop_sequence:  seq,
		})
	})
	if len(st) == 0 {
		return st
	}
	r.stopTimes.store(&st)
	return st
}

func (r *sacrtRegion) stopTimesForTrip(tripID string) []StopTimeInfo {
	return r.loadStopTimesRaw()[tripID]
}

func (r *sacrtRegion) loadStops() map[string]StopInfo {
	if m := r.stops.load(); m != nil {
		return *m
	}
	r.stopsMu.Lock()
	defer r.stopsMu.Unlock()
	if m := r.stops.load(); m != nil {
		return *m
	}
	stops := map[string]StopInfo{}
	scanCSVRows(filepath.Join(r.gtfsDir, "stops.txt"), func(rec map[string]string) {
		id := rec["stop_id"]
		if id == "" {
			return
		}
		stops[id] = StopInfo{
			stop_id:        id,
			stop_name:      rec["stop_name"],
			stop_lat:       rec["stop_lat"],
			stop_lon:       rec["stop_lon"],
			parent_station: rec["parent_station"],
		}
	})
	if len(stops) == 0 {
		return stops
	}
	r.stops.store(&stops)
	return stops
}

func (r *sacrtRegion) loadRoutes() map[string]RouteInfo {
	if m := r.routes.load(); m != nil {
		return *m
	}
	r.routesMu.Lock()
	defer r.routesMu.Unlock()
	if m := r.routes.load(); m != nil {
		return *m
	}
	routes := map[string]RouteInfo{}
	scanCSVRows(filepath.Join(r.gtfsDir, "routes.txt"), func(rec map[string]string) {
		id := rec["route_id"]
		if id != "" && rec["route_short_name"] != "" {
			routes[id] = RouteInfo{shortName: rec["route_short_name"], longName: rec["route_long_name"]}
		}
	})
	if len(routes) == 0 {
		return routes
	}
	r.routes.store(&routes)
	return routes
}

func (r *sacrtRegion) routeShortName(routeID string) string {
	if rt, ok := r.loadRoutes()[routeID]; ok && rt.shortName != "" {
		return rt.shortName
	}
	return routeID
}

func (r *sacrtRegion) loadStopGroups() map[string]StopGroup {
	if g := r.stopGroups.load(); g != nil {
		return *g
	}
	r.stopGroupsMu.Lock()
	defer r.stopGroupsMu.Unlock()
	if g := r.stopGroups.load(); g != nil {
		return *g
	}
	stops := r.loadStops()
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
	trips := r.loadTrips()
	routesPerStop := make(map[string]map[string]bool)
	for tripID, times := range r.loadStopTimesRaw() {
		trip, ok := trips[tripID]
		if !ok || trip.route_id == "" {
			continue
		}
		for _, st := range times {
			set := routesPerStop[st.stop_id]
			if set == nil {
				set = map[string]bool{}
				routesPerStop[st.stop_id] = set
			}
			set[trip.route_id] = true
		}
	}
	var groups []StopGroup
	for key, ids := range members {
		var routes []string
		seen := map[string]bool{}
		for _, id := range ids {
			for rid := range routesPerStop[id] {
				if !seen[rid] {
					seen[rid] = true
					routes = append(routes, rid)
				}
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
			GroupID: key, Name: rep.stop_name, Lat: lat, Lon: lon,
			Members: ids, RouteID: routes[0],
		})
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i].GroupID < groups[j].GroupID })
	groups = mergeNearbyStops(groups)
	byID := make(map[string]StopGroup, len(groups))
	for _, g := range groups {
		byID[g.GroupID] = g
	}
	log.Printf("[sacrt] loaded %d stop groups", len(byID))
	r.stopGroups.store(&byID)
	return byID
}

func (r *sacrtRegion) timezone() *time.Location {
	var tz string
	scanCSVRows(filepath.Join(r.gtfsDir, "agency.txt"), func(rec map[string]string) {
		if tz == "" && rec["agency_timezone"] != "" {
			tz = rec["agency_timezone"]
		}
	})
	if loc, err := time.LoadLocation(tz); err == nil {
		return loc
	}
	return time.UTC
}

func (r *sacrtRegion) activeServiceIDs(day time.Time) map[string]bool {
	active := map[string]bool{}
	date := day.Format("20060102")
	weekday := []string{"sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"}[int(day.Weekday())]
	scanCSVRows(filepath.Join(r.gtfsDir, "calendar.txt"), func(rec map[string]string) {
		if date >= rec["start_date"] && date <= rec["end_date"] && rec[weekday] == "1" {
			active[rec["service_id"]] = true
		}
	})
	scanCSVRows(filepath.Join(r.gtfsDir, "calendar_dates.txt"), func(rec map[string]string) {
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

func (r *sacrtRegion) departures(stopIDs map[string]bool, limit int) []map[string]interface{} {
	now := time.Now().In(r.timezone())
	nowSecs := now.Unix()
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).Unix()
	yesterday := now.AddDate(0, 0, -1)
	yesterdayStart := time.Date(yesterday.Year(), yesterday.Month(), yesterday.Day(), 0, 0, 0, 0, yesterday.Location()).Unix()
	services := r.activeServiceIDs(now)
	yserv := r.activeServiceIDs(yesterday)
	trips := r.loadTrips()
	type dep struct {
		abs int64
		st  StopTimeInfo
		t   TripInfo
	}
	var deps []dep
	for tripID, times := range r.loadStopTimesRaw() {
		trip, ok := trips[tripID]
		if !ok {
			continue
		}
		for _, st := range times {
			if !stopIDs[st.stop_id] || st.departure_time < 0 {
				continue
			}
			var abs int64
			switch {
			case services[trip.service_id]:
				abs = todayStart + int64(st.departure_time)
			case yserv[trip.service_id]:
				abs = yesterdayStart + int64(st.departure_time)
			default:
				continue
			}
			abs = r.tripUpdates.adjustedDeparture(trip.trip_id, st.stop_id, abs)
			if abs >= nowSecs {
				deps = append(deps, dep{abs: abs, st: st, t: trip})
			}
		}
	}
	sort.Slice(deps, func(i, j int) bool { return deps[i].abs < deps[j].abs })
	seen := map[string]bool{}
	out := make([]map[string]interface{}, 0, len(deps))
	for _, d := range deps {
		key := d.t.trip_id + "|" + strconv.FormatInt(d.abs, 10)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, map[string]interface{}{
			"trip_id":             d.t.trip_id,
			"route_id":            d.t.route_id,
			"route_short_name":    r.routeShortName(d.t.route_id),
			"trip_headsign":       d.t.trip_headsign,
			"direction_id":        d.t.direction_id,
			"arrival_time":        gtfsTimeString(d.st.arrival_time),
			"departure_time":      gtfsTimeString(d.st.departure_time),
			"departure_timestamp": d.abs,
		})
		if len(out) >= limit {
			break
		}
	}
	return out
}

// ---- shapes ----

func (r *sacrtRegion) shapeForTrip(shapeID string) ([][2]float64, error) {
	r.shapesCacheMu.RLock()
	if r.shapesCache != nil {
		if c, ok := r.shapesCache[shapeID]; ok {
			r.shapesCacheMu.RUnlock()
			return c, nil
		}
	}
	r.shapesCacheMu.RUnlock()
	r.shapesOnce.Do(func() {
		pts := map[string][][2]float64{}
		type pt struct {
			lat, lon float64
			seq      int
		}
		raw := map[string][]pt{}
		scanCSVRows(filepath.Join(r.gtfsDir, "shapes.txt"), func(rec map[string]string) {
			sid := rec["shape_id"]
			if sid == "" {
				return
			}
			lat, _ := strconv.ParseFloat(rec["shape_pt_lat"], 64)
			lon, _ := strconv.ParseFloat(rec["shape_pt_lon"], 64)
			seq, _ := strconv.Atoi(rec["shape_pt_sequence"])
			raw[sid] = append(raw[sid], pt{lat, lon, seq})
		})
		for sid, ps := range raw {
			sort.Slice(ps, func(i, j int) bool { return ps[i].seq < ps[j].seq })
			coords := make([][2]float64, len(ps))
			for i, p := range ps {
				coords[i] = [2]float64{p.lat, p.lon}
			}
			pts[sid] = coords
		}
		r.shapesCacheMu.Lock()
		r.shapesCache = pts
		r.shapesCacheMu.Unlock()
		log.Printf("[sacrt] loaded %d shapes", len(pts))
	})
	r.shapesCacheMu.RLock()
	defer r.shapesCacheMu.RUnlock()
	return r.shapesCache[shapeID], nil
}

// ---- realtime (GTFS-RT protobuf) ----

// refreshPositions polls the public SacRT vehicle-positions feed, converts the
// protobuf to JSON, enriches it from local GTFS, and caches it.
func (r *sacrtRegion) refreshPositions() error {
	body, err := fetchBody(sacrtVehiclesURL)
	if err != nil {
		return err
	}
	payload, err := r.parsePositions(body)
	if err != nil {
		return err
	}
	var parsed map[string]interface{}
	json.Unmarshal(payload, &parsed)

	r.positionsMu.Lock()
	r.positionsPayload = payload
	r.positionsParsed = parsed
	r.positionsTime = time.Now()
	r.positionsErr = nil
	r.positionsMu.Unlock()

	if r.positionsFile != "" {
		if err := os.MkdirAll(filepath.Dir(r.positionsFile), 0o755); err != nil {
			log.Printf("[sacrt] failed to create cache dir: %v", err)
		} else if err := os.WriteFile(r.positionsFile, payload, 0o644); err != nil {
			log.Printf("[sacrt] failed to persist vehicle positions: %v", err)
		}
	}
	return nil
}

// parsePositions converts a raw GTFS-realtime protobuf body into enriched
// vehicle-feed JSON, mirroring what the live feed produces.
func (r *sacrtRegion) parsePositions(body []byte) ([]byte, error) {
	var feed gtfs.FeedMessage
	if err := proto.Unmarshal(body, &feed); err != nil {
		return nil, fmt.Errorf("invalid GTFS-realtime protobuf from sacrt: %w", err)
	}
	marshaled, err := (protojson.MarshalOptions{}).Marshal(&feed)
	if err != nil {
		return nil, fmt.Errorf("failed to encode sacrt feed: %w", err)
	}
	return r.enrich(marshaled), nil
}

// enrich fills schedule fields (headdsign, stop name, delay, route short name)
// from local GTFS for each active trip. SacRT realtime IDs match the static
// GTFS directly, so no ID rewriting is needed.
func (r *sacrtRegion) enrich(payload []byte) []byte {
	var feed map[string]interface{}
	if err := json.Unmarshal(payload, &feed); err != nil {
		return payload
	}
	entities, ok := feed["entity"].([]interface{})
	if !ok {
		return payload
	}
	stops := r.loadStops()
	trips := r.loadTrips()
	routes := r.loadRoutes()
	loc := r.timezone()
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
			if stop, ok := stops[stopID]; ok && stop.stop_name != "" {
				vehicle["stopName"] = stop.stop_name
			}
		}
		var trip map[string]interface{}
		if t, ok := vehicle["trip"].(map[string]interface{}); ok {
			trip = t
		}
		if trip != nil {
			tripID, _ := trip["tripId"].(string)
			if tripInfo, found := trips[tripID]; found {
				trip["tripInfoFound"] = true
				trip["tripHeadsign"] = tripInfo.trip_headsign
				trip["serviceId"] = tripInfo.service_id
				trip["shapeId"] = tripInfo.shape_id
				trip["blockId"] = tripInfo.block_id
				if routeID, _ := trip["routeId"].(string); routeID == "" {
					trip["routeId"] = tripInfo.route_id
				}
				if _, hasDir := trip["directionId"]; !hasDir {
					if d, err := strconv.Atoi(tripInfo.direction_id); err == nil {
						trip["directionId"] = d
					}
				}
				if routeID, _ := trip["routeId"].(string); routeID != "" {
					if route, ok := routes[routeID]; ok && route.shortName != "" {
						vehicle["routeShortName"] = route.shortName
					}
				}
			}
		}
		if trip != nil {
			if tripID, _ := trip["tripId"].(string); tripID != "" {
				if stopID, _ := vehicle["stopId"].(string); stopID != "" {
					for _, st := range r.stopTimesForTrip(tripID) {
						if st.stop_id == stopID {
							trip["delay"] = nowSec - st.departure_time
							break
						}
					}
				}
			}
		}
		enrichVehicleType(vehicle, "SRTD")
	}
	out, err := json.Marshal(feed)
	if err != nil {
		return payload
	}
	return out
}

// refreshTripUpdates polls the public SacRT trip-updates feed and stores the
// per-stop predictions for the departures/delay lookups.
func (r *sacrtRegion) refreshTripUpdates() error {
	body, err := fetchBody(sacrtTripsURL)
	if err != nil {
		return err
	}
	var feed gtfs.FeedMessage
	if err := proto.Unmarshal(body, &feed); err != nil {
		return fmt.Errorf("invalid GTFS-realtime protobuf from sacrt trips: %w", err)
	}
	r.tripUpdates.set(tripUpdatePredictions(&feed))
	return nil
}

func (r *sacrtRegion) runRefresher() {
	if err := r.refreshPositions(); err != nil {
		log.Printf("[sacrt] positions refresh failed: %v", err)
	}
	if err := r.refreshTripUpdates(); err != nil {
		log.Printf("[sacrt] trip updates refresh failed: %v", err)
	}
	ticker := time.NewTicker(r.refreshInterval)
	defer ticker.Stop()
	for range ticker.C {
		if err := r.refreshPositions(); err != nil {
			log.Printf("[sacrt] positions refresh failed: %v", err)
		}
		if err := r.refreshTripUpdates(); err != nil {
			log.Printf("[sacrt] trip updates refresh failed: %v", err)
		}
	}
}

// startSacrtRegion performs one-time initialization: refresh static GTFS,
// pre-compute JSON caches, seed any on-disk realtime cache, and start the
// realtime refresher. Unlike Seattle there is no API key, so it always runs.
func startSacrtRegion() {
	sacrt.initDirs()
	go func() {
		if err := sacrt.loadStatic(); err != nil {
			log.Printf("[sacrt] static GTFS load failed: %v", err)
			return
		}
		os.MkdirAll(sacrt.tripDataDir, 0o755)
		for _, table := range []string{"agency", "routes", "stops"} {
			if err := cacheDatafeedJSONSacrt(table); err != nil {
				log.Printf("[sacrt] failed to pre-compute %s.json: %v", table, err)
			}
		}
		sacrt.loadTrips()
		sacrt.loadStops()
		sacrt.loadRoutes()
		log.Println("[sacrt] static GTFS loaded")
	}()
	if data, err := os.ReadFile(sacrt.positionsFile); err == nil && len(data) > 0 {
		var feed map[string]interface{}
		sacrt.positionsMu.Lock()
		sacrt.positionsPayload = data
		if err := json.Unmarshal(data, &feed); err == nil {
			sacrt.positionsParsed = feed
		}
		sacrt.positionsTime = time.Now()
		sacrt.positionsMu.Unlock()
		log.Println("[sacrt] loaded cached vehicle positions from disk")
	} else {
		log.Println("[sacrt] no disk cache for vehicle positions")
	}
	go sacrt.runRefresher()
}

// cacheDatafeedJSONSacrt writes a GTFS CSV table from the SacRT dir to the
// equivalent <name>.json cache, mirroring cacheDatafeedJSONSeattle.
func cacheDatafeedJSONSacrt(name string) error {
	src := filepath.Join(sacrt.gtfsDir, name+".txt")
	outPath := filepath.Join(sacrt.tripDataDir, name+".json")
	if err := os.MkdirAll(sacrt.tripDataDir, 0o755); err != nil {
		return err
	}
	f, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer f.Close()
	return streamCSVAsJSON(src, f)
}

// ---- resolvers ----

func (r *sacrtRegion) vehicles() (interface{}, time.Time) {
	r.positionsMu.RLock()
	defer r.positionsMu.RUnlock()
	return r.positionsParsed, r.positionsTime
}

func (r *sacrtRegion) readAgencyJSON() []interface{} {
	arr, _ := readJSONArray(filepath.Join(r.tripDataDir, "agency.json"))
	return arr
}

func (r *sacrtRegion) readRoutes() []interface{} {
	arr, _ := readJSONArray(filepath.Join(r.tripDataDir, "routes.json"))
	return arr
}

func (r *sacrtRegion) readStops() []interface{} {
	arr, _ := readJSONArray(filepath.Join(r.tripDataDir, "stops.json"))
	return arr
}

// sacrtTripDetail builds a trip detail (schedule + shape) from the SacRT
// region GTFS.
func sacrtTripDetail(tripID string) (interface{}, error) {
	trips := sacrt.loadTrips()
	trip, ok := trips[tripID]
	if !ok {
		return nil, nil
	}
	stops := sacrt.loadStops()
	times := sacrt.stopTimesForTrip(tripID)
	schedule := make([]map[string]interface{}, 0, len(times))
	for _, st := range times {
		stop := stops[st.stop_id]
		schedule = append(schedule, map[string]interface{}{
			"stop_id":        st.stop_id,
			"stop_sequence":  st.stop_sequence,
			"arrival_time":   gtfsTimeString(st.arrival_time),
			"departure_time": gtfsTimeString(st.departure_time),
			"stop_name":      stop.stop_name,
			"stop_lat":       stop.stop_lat,
			"stop_lon":       stop.stop_lon,
		})
	}
	var shapeCoords [][2]float64
	if trip.shape_id != "" {
		if c, err := sacrt.shapeForTrip(trip.shape_id); err == nil {
			shapeCoords = c
		}
	}
	shape := make([][]float64, len(shapeCoords))
	for i, c := range shapeCoords {
		shape[i] = []float64{c[0], c[1]}
	}
	return map[string]interface{}{
		"trip_id":         trip.trip_id,
		"route_id":        trip.route_id,
		"service_id":      trip.service_id,
		"trip_headsign":   trip.trip_headsign,
		"direction_id":    trip.direction_id,
		"shape_id":        trip.shape_id,
		"block_id":        trip.block_id,
		"trip_short_name": trip.trip_short_name,
		"shape":           shape,
		"schedule":        schedule,
	}, nil
}
