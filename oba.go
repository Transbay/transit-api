package main

import (
	"encoding/json"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"
)

const (
	obaBaseURL     = "https://api.pugetsound.onebusaway.org/api/where"
	obaSoundAgency = "40"
	obaGTFSURL     = "https://gtfs.sound.obaweb.org/prod/gtfs_puget_sound_consolidated.zip"
)

var obaIDPrefix = regexp.MustCompile(`^\d+_`)

func stripObaPrefix(id string) string {
	if loc := obaIDPrefix.FindStringIndex(id); loc != nil {
		return id[loc[1]:]
	}
	return id
}

var (
	errMissingOBAKey = errSkip("SOUND_TRANSIT_API_KEY not set; Sound Transit region disabled")
	errOBANon200     = errSkip("OneBusAway API returned non-2xx status")
)

type errSkip string

func (e errSkip) Error() string { return string(e) }

func downloadStaticGTFS(rawURL, destination, keyEnv, _ string) error {
	url := rawURL
	if keyEnv != "" {
		if k := os.Getenv(keyEnv); k != "" {
			url = rawURL + "?key=" + k
		}
	}
	body, err := fetchBody(url)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	return os.WriteFile(destination, body, 0o644)
}

func fetchBody(url string) ([]byte, error) {
	client := &http.Client{Timeout: 90 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, errSkip("GET " + url + " -> " + strconv.Itoa(resp.StatusCode))
	}
	body, err := readResponseBody(resp)
	if err != nil {
		return nil, err
	}
	return body, nil
}

var seattle = newSeattleRegion()

type seattleRegion struct {
	dir             string
	gtfsZip         string
	gtfsDir         string
	tripDataDir     string
	tripDetailsDir  string
	shapesDir       string
	positionsFile   string
	refreshInterval time.Duration
	apiKeyEnv       string
	agencyID        string

	positionsMu      sync.RWMutex
	positionsPayload []byte
	positionsParsed  interface{}
	positionsTime    time.Time
	positionsErr     error

	speedHistMu   sync.Mutex
	speedHist     map[string]speedSample
	lastRefreshAt time.Time

	tripUpdates tripUpdateStore

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
	firstTripMu  sync.Once
	firstTrip    map[string]string

	shapesCache   map[string][][2]float64
	shapesOnce    sync.Once
	shapesCacheMu sync.RWMutex
}

type atomicPtr[T any] struct {
	mu  sync.Mutex
	val *T
}

func (a *atomicPtr[T]) load() *T {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.val
}

func (a *atomicPtr[T]) store(v *T) {
	a.mu.Lock()
	a.val = v
	a.mu.Unlock()
}

func newSeattleRegion() *seattleRegion {
	work, _ := os.Getwd()
	return &seattleRegion{
		dir:             filepath.Join(work, "data", "seattle"),
		refreshInterval: time.Minute,
		apiKeyEnv:       "SOUND_TRANSIT_API_KEY",
		agencyID:        obaSoundAgency,
		speedHist:       map[string]speedSample{},
	}
}

func (r *seattleRegion) initDirs() {
	r.gtfsZip = filepath.Join(r.dir, "gtfs.zip")
	r.gtfsDir = filepath.Join(r.dir, "gtfs")
	r.tripDataDir = filepath.Join(r.dir, "tripdata")
	r.tripDetailsDir = filepath.Join(r.dir, "tripdetails")
	r.shapesDir = filepath.Join(r.dir, "shapes")
	r.positionsFile = filepath.Join(r.dir, "vehicle_positions.json")
}

func (r *seattleRegion) apiKey() (string, error) {
	k := os.Getenv(r.apiKeyEnv)
	if k == "" {
		return "", errMissingOBAKey
	}
	return k, nil
}

func (r *seattleRegion) loadStatic() error {
	if err := downloadStaticGTFS(obaGTFSURL, r.gtfsZip, "", ""); err != nil {
		return err
	}
	return unzipDatafeed(r.gtfsZip, r.gtfsDir)
}

func (r *seattleRegion) loadTrips() map[string]TripInfo {
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
	r.trips.store(&trips)
	return trips
}

func (r *seattleRegion) _fillTripTimes(trips map[string]TripInfo) {
	st := r.loadStopTimesRaw()
	for tid, times := range st {
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

func (r *seattleRegion) loadStopTimesRaw() map[string][]StopTimeInfo {
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
	r.stopTimes.store(&st)
	return st
}

func (r *seattleRegion) stopTimesForTrip(tripID string) []StopTimeInfo {
	return r.loadStopTimesRaw()[tripID]
}

func (r *seattleRegion) loadStops() map[string]StopInfo {
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
	r.stops.store(&stops)
	return stops
}

func (r *seattleRegion) loadRoutes() map[string]RouteInfo {
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
	r.routes.store(&routes)
	return routes
}

func (r *seattleRegion) routeShortName(routeID string) string {
	if rt, ok := r.loadRoutes()[routeID]; ok && rt.shortName != "" {
		return rt.shortName
	}
	return routeID
}

func (r *seattleRegion) loadStopGroups() map[string]StopGroup {
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
	log.Printf("[seattle] loaded %d stop groups", len(byID))
	r.stopGroups.store(&byID)
	return byID
}

func (r *seattleRegion) timezone() *time.Location {
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

func (r *seattleRegion) activeServiceIDs(day time.Time) map[string]bool {
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

func (r *seattleRegion) departures(stopIDs map[string]bool, limit int) []map[string]interface{} {
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

func (r *seattleRegion) firstTripOnRoute(routeID string) string {
	r.firstTripMu.Do(func() {
		m := map[string]string{}
		for _, t := range r.loadTrips() {
			if _, ok := m[t.route_id]; !ok {
				m[t.route_id] = t.trip_id
			}
		}
		r.firstTrip = m
	})
	return r.firstTrip[routeID]
}

func (r *seattleRegion) shapeForTrip(shapeID string) ([][2]float64, error) {
	shapeID = stripObaPrefix(shapeID)
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
		log.Printf("[seattle] loaded %d shapes", len(pts))
	})
	r.shapesCacheMu.RLock()
	defer r.shapesCacheMu.RUnlock()
	return r.shapesCache[shapeID], nil
}

type obaEnvelope struct {
	Code int     `json:"code"`
	Data obaData `json:"data"`
	Text string  `json:"text"`
}

type obaData struct {
	List       []obaVehicle `json:"list"`
	References obaRefs      `json:"references"`
}

type obaVehicle struct {
	VehicleID   string     `json:"vehicleId"`
	TripID      string     `json:"tripId"`
	Phase       string     `json:"phase"`
	Status      string     `json:"status"`
	Location    *obaPoint  `json:"location"`
	TripStatus  *obaTripSt `json:"tripStatus"`
	OccupStatus string     `json:"occupancyStatus"`
	LastUpdate  int64      `json:"lastUpdateTime"`
}

type obaPoint struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

type obaTripSt struct {
	TripID    string    `json:"activeTripId"`
	Deviation int       `json:"scheduleDeviation"`
	Position  *obaPoint `json:"position"`
	Orienta   float64   `json:"orientation"`
	Closest   string    `json:"closestStop"`
}

type obaRefs struct {
	Routes []obaRoute `json:"routes"`
	Stops  []obaStop  `json:"stops"`
	Trips  []obaTrip  `json:"trips"`
}

type obaRoute struct {
	ID        string `json:"id"`
	AgencyID  string `json:"agencyId"`
	ShortName string `json:"shortName"`
	LongName  string `json:"longName"`
	Color     string `json:"color"`
	TextColor string `json:"textColor"`
	Type      int    `json:"type"`
}

type obaStop struct {
	ID   string  `json:"id"`
	Name string  `json:"name"`
	Lat  float64 `json:"lat"`
	Lon  float64 `json:"lon"`
}

type obaTrip struct {
	ID        string `json:"id"`
	RouteID   string `json:"routeId"`
	HeadSign  string `json:"tripHeadsign"`
	ServiceID string `json:"serviceId"`
	ShapeID   string `json:"shapeId"`
	Direction string `json:"directionId"`
	BlockID   string `json:"blockId"`
	ShortName string `json:"tripShortName"`
}

func (r *seattleRegion) refreshPositions() error {
	key, err := r.apiKey()
	if err != nil {
		return err
	}
	url := obaBaseURL + "/vehicles-for-agency/" + r.agencyID + ".json?key=" + key
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return errOBANon200
	}
	var env obaEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		return err
	}

	perTrip := map[string]int64{}
	for _, v := range env.Data.List {
		if v.TripID == "" || v.TripStatus == nil {
			continue
		}
		perTrip[stripObaPrefix(v.TripID)] = int64(v.TripStatus.Deviation)
	}
	r.tripUpdates.set(tripUpdateData{perTrip: perTrip})

	payload, _ := r.buildVehicleFeed(&env)
	var parsed map[string]interface{}
	json.Unmarshal(payload, &parsed)
	r.annotateSpeeds(parsed)
	payload, _ = json.Marshal(parsed)

	r.positionsMu.Lock()
	r.positionsPayload = payload
	r.positionsParsed = parsed
	r.positionsTime = time.Now()
	r.positionsErr = nil
	r.positionsMu.Unlock()

	if r.positionsFile != "" {
		if err := os.MkdirAll(filepath.Dir(r.positionsFile), 0o755); err != nil {
			log.Printf("[seattle] failed to create cache dir: %v", err)
		} else if err := os.WriteFile(r.positionsFile, payload, 0o644); err != nil {
			log.Printf("[seattle] failed to persist vehicle positions: %v", err)
		}
	}
	return nil
}

type speedSample struct {
	lat, lon float64
	at       time.Time
}

func haversineMeters(lat1, lon1, lat2, lon2 float64) float64 {
	const earthRadiusM = 6371000.0
	toRad := math.Pi / 180
	dLat := (lat2 - lat1) * toRad
	dLon := (lon2 - lon1) * toRad
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*toRad)*math.Cos(lat2*toRad)*math.Sin(dLon/2)*math.Sin(dLon/2)
	return 2 * earthRadiusM * math.Asin(math.Sqrt(a))
}

func (r *seattleRegion) computeSpeed(vehID string, lat, lon float64, at time.Time) float64 {
	r.speedHistMu.Lock()
	defer r.speedHistMu.Unlock()
	var mph float64
	if prev, ok := r.speedHist[vehID]; ok {
		if dtH := at.Sub(prev.at).Hours(); dtH > 0 {
			mph = (haversineMeters(prev.lat, prev.lon, lat, lon) / 1609.344) / dtH
			if mph < 0 {
				mph = 0
			}
		}
	}
	r.speedHist[vehID] = speedSample{lat: lat, lon: lon, at: at}
	return mph
}

func (r *seattleRegion) annotateSpeeds(feed map[string]interface{}) {
	entities, ok := feed["entity"].([]interface{})
	if !ok {
		return
	}
	now := time.Now()
	for _, e := range entities {
		ent, ok := e.(map[string]interface{})
		if !ok {
			continue
		}
		vehicle, ok := ent["vehicle"].(map[string]interface{})
		if !ok {
			continue
		}
		pos, ok := vehicle["position"].(map[string]interface{})
		if !ok {
			continue
		}
		lat, ok1 := pos["latitude"].(float64)
		lon, ok2 := pos["longitude"].(float64)
		id, _ := ent["id"].(string)
		if !ok1 || !ok2 || id == "" {
			continue
		}
		pos["speed"] = r.computeSpeed(id, lat, lon, now)
	}
}

func (r *seattleRegion) buildVehicleFeed(env *obaEnvelope) ([]byte, map[string]interface{}) {
	routeByName := map[string]obaRoute{}
	for _, rt := range env.Data.References.Routes {
		routeByName[rt.ID] = rt
	}
	tripRef := map[string]obaTrip{}
	for _, t := range env.Data.References.Trips {
		tripRef[t.ID] = t
	}
	stopRef := map[string]obaStop{}
	for _, s := range env.Data.References.Stops {
		stopRef[s.ID] = s
	}

	entities := make([]interface{}, 0, len(env.Data.List))
	for _, v := range env.Data.List {
		position := v.Location
		if v.TripStatus != nil && v.TripStatus.Position != nil {
			position = v.TripStatus.Position
		}
		trip := map[string]interface{}{
			"tripId": v.TripID,
		}
		if ts := v.TripStatus; ts != nil {
			trip["delay"] = ts.Deviation
			if tr, ok := tripRef[v.TripID]; ok {
				trip["routeId"] = tr.RouteID
				trip["tripHeadsign"] = tr.HeadSign
				trip["serviceId"] = tr.ServiceID
				trip["shapeId"] = tr.ShapeID
				trip["blockId"] = tr.BlockID
				trip["tripShortName"] = tr.ShortName
			}
		}

		veh := map[string]interface{}{
			"id": v.VehicleID,
		}
		vehicle := map[string]interface{}{
			"stopId":          "",
			"stopName":        "",
			"occupancyStatus": v.OccupStatus,
			"timestamp":       v.LastUpdate,
			"trip":            trip,
			"vehicle":         veh,
		}
		if ts := v.TripStatus; ts != nil && ts.Closest != "" {
			vehicle["stopId"] = stripObaPrefix(ts.Closest)
			if s, ok := stopRef[ts.Closest]; ok && s.Name != "" {
				vehicle["stopName"] = s.Name
			}
		}
		if position != nil {
			vehicle["position"] = map[string]interface{}{"latitude": position.Lat, "longitude": position.Lon}
			if v.TripStatus != nil {
				vehicle["bearing"] = v.TripStatus.Orienta
			}
		}
		routeID, _ := trip["routeId"].(string)
		if routeID != "" {
			if rt, ok := routeByName[routeID]; ok && rt.ShortName != "" {
				vehicle["routeShortName"] = rt.ShortName
			}
		}
		entities = append(entities, map[string]interface{}{
			"id":      v.VehicleID,
			"vehicle": vehicle,
		})
	}

	feed := map[string]interface{}{"entity": entities}
	payload, err := json.Marshal(feed)
	if err != nil {
		payload = nil
	}
	return r.enrich(payload), feed
}

func (r *seattleRegion) enrich(payload []byte) []byte {
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
	loc := r.timezone()
	now := time.Now().In(loc)
	nowSec := now.Hour()*3600 + now.Minute()*60 + now.Second()
	for _, e := range entities {
		ent, ok := e.(map[string]interface{})
		if !ok {
			continue
		}
		vehicle, ok := ent["vehicle"].(map[string]interface{})
		if !ok {
			continue
		}
		trip, ok := vehicle["trip"].(map[string]interface{})
		if !ok {
			continue
		}
		tripID, _ := trip["tripId"].(string)
		gID := stripObaPrefix(tripID)
		tinfo, found := trips[gID]
		if !found {
			continue
		}
		trip["tripInfoFound"] = true
		trip["tripHeadsign"] = tinfo.trip_headsign
		trip["serviceId"] = tinfo.service_id
		trip["shapeId"] = tinfo.shape_id
		trip["blockId"] = tinfo.block_id
		trip["tripShortName"] = tinfo.trip_short_name
		if row, ok := trip["routeId"].(string); !ok || row == "" {
			trip["routeId"] = obaSoundAgency + "_" + tinfo.route_id
		}
		if rid, _ := trip["routeId"].(string); rid != "" {
			if short := r.routeShortName(stripObaPrefix(rid)); short != "" {
				vehicle["routeShortName"] = short
			}
		}
		if deliverRoute, ok := trip["routeId"].(string); ok && stripObaPrefix(deliverRoute) != tinfo.route_id {
			if eff := r.firstTripOnRoute(tinfo.route_id); eff != "" {
				if effInfo, ok := trips[eff]; ok {
					trip["tripId"] = eff
					trip["shapeId"] = effInfo.shape_id
				}
			}
		}
		if sid, _ := vehicle["stopId"].(string); sid != "" {
			gstop := stripObaPrefix(sid)
			if s, ok := stops[gstop]; ok && s.stop_name != "" {
				vehicle["stopName"] = s.stop_name
			}
			for _, st := range r.stopTimesForTrip(gID) {
				if st.stop_id == gstop {
					trip["delay"] = nowSec - st.departure_time
					break
				}
			}
		}
	}
	out, err := json.Marshal(feed)
	if err != nil {
		return payload
	}
	return out
}

func (r *seattleRegion) runRefresher() {
	if err := r.refreshPositions(); err != nil {
		log.Printf("[seattle] positions refresh failed: %v", err)
	}
	ticker := time.NewTicker(r.refreshInterval)
	defer ticker.Stop()
	for range ticker.C {
		if err := r.refreshPositions(); err != nil {
			log.Printf("[seattle] positions refresh failed: %v", err)
		}
	}
}

func startSeattleRegion() {
	seattle.initDirs()
	if _, err := seattle.apiKey(); err != nil {
		log.Printf("[seattle] region disabled: %v", err)
		return
	}
	go func() {
		if err := seattle.loadStatic(); err != nil {
			log.Printf("[seattle] static GTFS load failed: %v", err)
			return
		}
		os.MkdirAll(seattle.tripDataDir, 0o755)
		for _, table := range []string{"agency", "routes", "stops"} {
			if err := cacheDatafeedJSONSeattle(table); err != nil {
				log.Printf("[seattle] failed to pre-compute %s.json: %v", table, err)
			}
		}
		seattle.loadTrips()
		seattle.loadStops()
		seattle.loadRoutes()
		log.Println("[seattle] static GTFS loaded")
	}()
	if data, err := os.ReadFile(seattle.positionsFile); err == nil && len(data) > 0 {
		var feed map[string]interface{}
		seattle.positionsMu.Lock()
		seattle.positionsPayload = data
		seattle.positionsParsed = feed
		if err := json.Unmarshal(data, &feed); err == nil {
			seattle.positionsParsed = feed
		}
		seattle.positionsTime = time.Now()
		seattle.positionsMu.Unlock()
		log.Println("[seattle] loaded cached vehicle positions from disk")
	} else {
		log.Println("[seattle] no disk cache for vehicle positions")
	}
	go seattle.runRefresher()
}

func cacheDatafeedJSONSeattle(name string) error {
	src := filepath.Join(seattle.gtfsDir, name+".txt")
	outPath := filepath.Join(seattle.tripDataDir, name+".json")
	if err := os.MkdirAll(seattle.tripDataDir, 0o755); err != nil {
		return err
	}
	f, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer f.Close()
	return streamCSVAsJSON(src, f)
}

func (r *seattleRegion) vehicles() (interface{}, time.Time) {
	r.positionsMu.RLock()
	defer r.positionsMu.RUnlock()
	return r.positionsParsed, r.positionsTime
}

func (r *seattleRegion) readAgencyJSON() []interface{} {
	arr, _ := readJSONArray(filepath.Join(r.tripDataDir, "agency.json"))
	return arr
}

func (r *seattleRegion) readRoutes() []interface{} {
	arr, _ := readJSONArray(filepath.Join(r.tripDataDir, "routes.json"))
	return arr
}

func (r *seattleRegion) readStops() []interface{} {
	arr, _ := readJSONArray(filepath.Join(r.tripDataDir, "stops.json"))
	return arr
}
