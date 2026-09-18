package main

// Elk Grove Transit (SacRT Elk Grove / e-tran) via the public GTFS +
// GTFS-realtime feeds. Runs as a self-contained region beside the Bay Area
// (511), Sound Transit (OBA), and SacRT regions, keeping its own directory
// paths and caches. Realtime feeds are public GTFS-RT protobuf, so no API key
// is needed and the IDs line up directly with the static GTFS.
//
// ponytail: duplicate loader logic as sacrt.go/oba.go; fold all into a shared
// Region type if yet another region arrives.

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
	elkGTFSURL     = "https://apps.sacrt.com/gtfs/eg/google_transit.zip"
	elkVehiclesURL = "https://bustime.sacrt.com/EG_gtfsrt/vehicles"
	elkTripsURL    = "https://bustime.sacrt.com/EG_gtfsrt/trips"
)

var elk = newElkRegion()

type elkRegion struct {
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

func newElkRegion() *elkRegion {
	work, _ := os.Getwd()
	return &elkRegion{
		dir:             filepath.Join(work, "data", "elk"),
		refreshInterval: time.Minute,
	}
}

func (r *elkRegion) initDirs() {
	r.gtfsZip = filepath.Join(r.dir, "gtfs.zip")
	r.gtfsDir = filepath.Join(r.dir, "gtfs")
	r.tripDataDir = filepath.Join(r.dir, "tripdata")
	r.shapesDir = filepath.Join(r.dir, "shapes")
	r.positionsFile = filepath.Join(r.dir, "vehicle_positions.json")
}

// ---- static GTFS ----

func (r *elkRegion) loadStatic() error {
	if err := downloadStaticGTFS(elkGTFSURL, r.gtfsZip, "", ""); err != nil {
		return err
	}
	return unzipDatafeed(r.gtfsZip, r.gtfsDir)
}

func (r *elkRegion) loadTrips() map[string]TripInfo {
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

func (r *elkRegion) _fillTripTimes(trips map[string]TripInfo) {
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

func (r *elkRegion) loadStopTimesRaw() map[string][]StopTimeInfo {
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

func (r *elkRegion) stopTimesForTrip(tripID string) []StopTimeInfo {
	return r.loadStopTimesRaw()[tripID]
}

func (r *elkRegion) loadStops() map[string]StopInfo {
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

func (r *elkRegion) loadRoutes() map[string]RouteInfo {
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

func (r *elkRegion) routeShortName(routeID string) string {
	if rt, ok := r.loadRoutes()[routeID]; ok && rt.shortName != "" {
		return rt.shortName
	}
	return routeID
}

func (r *elkRegion) loadStopGroups() map[string]StopGroup {
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
	log.Printf("[elk] loaded %d stop groups", len(byID))
	r.stopGroups.store(&byID)
	return byID
}

func (r *elkRegion) timezone() *time.Location {
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

func (r *elkRegion) activeServiceIDs(day time.Time) map[string]bool {
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

func (r *elkRegion) departures(stopIDs map[string]bool, limit int) []map[string]interface{} {
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

func (r *elkRegion) shapeForTrip(shapeID string) ([][2]float64, error) {
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
		log.Printf("[elk] loaded %d shapes", len(pts))
	})
	r.shapesCacheMu.RLock()
	defer r.shapesCacheMu.RUnlock()
	return r.shapesCache[shapeID], nil
}

// ---- realtime (GTFS-RT protobuf) ----

// refreshPositions polls the public Elk Grove vehicle-positions feed, converts the
// protobuf to JSON, enriches it from local GTFS, and caches it.
func (r *elkRegion) refreshPositions() error {
	body, err := fetchBody(elkVehiclesURL)
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
			log.Printf("[elk] failed to create cache dir: %v", err)
		} else if err := os.WriteFile(r.positionsFile, payload, 0o644); err != nil {
			log.Printf("[elk] failed to persist vehicle positions: %v", err)
		}
	}
	return nil
}

// parsePositions converts a raw GTFS-realtime protobuf body into enriched
// vehicle-feed JSON, mirroring what the live feed produces.
func (r *elkRegion) parsePositions(body []byte) ([]byte, error) {
	var feed gtfs.FeedMessage
	if err := proto.Unmarshal(body, &feed); err != nil {
		return nil, fmt.Errorf("invalid GTFS-realtime protobuf from elk: %w", err)
	}
	marshaled, err := (protojson.MarshalOptions{}).Marshal(&feed)
	if err != nil {
		return nil, fmt.Errorf("failed to encode elk feed: %w", err)
	}
	return r.enrich(marshaled), nil
}

// enrich fills schedule fields (headdsign, stop name, delay, route short name)
// from local GTFS for each active trip. Elk Grove realtime IDs match the static
// GTFS directly, so no ID rewriting is needed.
func (r *elkRegion) enrich(payload []byte) []byte {
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
		enrichVehicleType(vehicle, "e-tran")
	}
	out, err := json.Marshal(feed)
	if err != nil {
		return payload
	}
	return out
}

// refreshTripUpdates polls the public Elk Grove trip-updates feed and stores the
// per-stop predictions for the departures/delay lookups.
func (r *elkRegion) refreshTripUpdates() error {
	body, err := fetchBody(elkTripsURL)
	if err != nil {
		return err
	}
	var feed gtfs.FeedMessage
	if err := proto.Unmarshal(body, &feed); err != nil {
		return fmt.Errorf("invalid GTFS-realtime protobuf from elk trips: %w", err)
	}
	r.tripUpdates.set(tripUpdatePredictions(&feed))
	return nil
}

func (r *elkRegion) runRefresher() {
	if err := r.refreshPositions(); err != nil {
		log.Printf("[elk] positions refresh failed: %v", err)
	}
	if err := r.refreshTripUpdates(); err != nil {
		log.Printf("[elk] trip updates refresh failed: %v", err)
	}
	ticker := time.NewTicker(r.refreshInterval)
	defer ticker.Stop()
	for range ticker.C {
		if err := r.refreshPositions(); err != nil {
			log.Printf("[elk] positions refresh failed: %v", err)
		}
		if err := r.refreshTripUpdates(); err != nil {
			log.Printf("[elk] trip updates refresh failed: %v", err)
		}
	}
}

// startElkRegion performs one-time initialization: refresh static GTFS,
// pre-compute JSON caches, seed any on-disk realtime cache, and start the
// realtime refresher. Unlike Seattle there is no API key, so it always runs.
func startElkRegion() {
	elk.initDirs()
	go func() {
		if err := elk.loadStatic(); err != nil {
			log.Printf("[elk] static GTFS load failed: %v", err)
			return
		}
		os.MkdirAll(elk.tripDataDir, 0o755)
		for _, table := range []string{"agency", "routes", "stops"} {
			if err := cacheDatafeedJSONElk(table); err != nil {
				log.Printf("[elk] failed to pre-compute %s.json: %v", table, err)
			}
		}
		elk.loadTrips()
		elk.loadStops()
		elk.loadRoutes()
		log.Println("[elk] static GTFS loaded")
	}()
	if data, err := os.ReadFile(elk.positionsFile); err == nil && len(data) > 0 {
		var feed map[string]interface{}
		elk.positionsMu.Lock()
		elk.positionsPayload = data
		if err := json.Unmarshal(data, &feed); err == nil {
			elk.positionsParsed = feed
		}
		elk.positionsTime = time.Now()
		elk.positionsMu.Unlock()
		log.Println("[elk] loaded cached vehicle positions from disk")
	} else {
		log.Println("[elk] no disk cache for vehicle positions")
	}
	go elk.runRefresher()
}

// cacheDatafeedJSONElk writes a GTFS CSV table from the Elk Grove dir to the
// equivalent <name>.json cache, mirroring cacheDatafeedJSONSeattle.
func cacheDatafeedJSONElk(name string) error {
	src := filepath.Join(elk.gtfsDir, name+".txt")
	outPath := filepath.Join(elk.tripDataDir, name+".json")
	if err := os.MkdirAll(elk.tripDataDir, 0o755); err != nil {
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

func (r *elkRegion) vehicles() (interface{}, time.Time) {
	r.positionsMu.RLock()
	defer r.positionsMu.RUnlock()
	return r.positionsParsed, r.positionsTime
}

func (r *elkRegion) readAgencyJSON() []interface{} {
	arr, _ := readJSONArray(filepath.Join(r.tripDataDir, "agency.json"))
	return arr
}

func (r *elkRegion) readRoutes() []interface{} {
	arr, _ := readJSONArray(filepath.Join(r.tripDataDir, "routes.json"))
	return arr
}

func (r *elkRegion) readStops() []interface{} {
	arr, _ := readJSONArray(filepath.Join(r.tripDataDir, "stops.json"))
	return arr
}

// elkTripDetail builds a trip detail (schedule + shape) from the Elk Grove
// region GTFS.
func elkTripDetail(tripID string) (interface{}, error) {
	trips := elk.loadTrips()
	trip, ok := trips[tripID]
	if !ok {
		return nil, nil
	}
	stops := elk.loadStops()
	times := elk.stopTimesForTrip(tripID)
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
		if c, err := elk.shapeForTrip(trip.shape_id); err == nil {
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