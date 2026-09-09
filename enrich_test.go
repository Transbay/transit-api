package main

import (
	"encoding/csv"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// requireGTFS skips when the static archive is not on disk.
//
// `data/` is gitignored and populated at runtime, so a fresh checkout has none. The tests
// below assert against real GTFS, which is the right thing for them to do -- but without
// this they fail rather than skip, and they fail with a misleading message: the first
// thing TestStopDepartures checks is that today has active services, so an absent archive
// reports itself as "calendar parsing is broken".
//
// TestEnrichVehiclePositionsTripInfo already skips this way. This just gives the other two
// the same courtesy, so a red suite means something is actually wrong.
func requireGTFS(t *testing.T) {
	t.Helper()
	for _, f := range []string{"trips.txt", "stop_times.txt", "calendar.txt"} {
		if _, err := os.Stat(filepath.Join(datafeedsDir, f)); err != nil {
			t.Skipf("no static GTFS on disk (%s); run the server once to populate data/", f)
		}
	}
}

func TestEnrichVehiclePositionsTripInfo(t *testing.T) {
	datafeedsDir = filepath.Join("data", "gtfs")

	file, err := os.Open(filepath.Join(datafeedsDir, "trips.txt"))
	if err != nil {
		t.Skipf("no trips.txt available: %v", err)
	}
	defer file.Close()
	reader := csv.NewReader(file)
	reader.FieldsPerRecord = -1
	headers, err := reader.Read()
	if err != nil {
		t.Skipf("empty trips.txt: %v", err)
	}
	tripIDIdx := -1
	for i, h := range headers {
		if h == "trip_id" {
			tripIDIdx = i
		}
	}
	record, err := reader.Read()
	if err != nil || tripIDIdx < 0 || record[tripIDIdx] == "" {
		t.Skipf("no usable trip row: %v", err)
	}
	tripID := record[tripIDIdx]

	payload := []byte(`{"entity":[{"id":"e1","vehicle":{"trip":{"tripId":"` + tripID + `"},"stopId":""}}]}`)
	out := enrichVehiclePositions(payload)

	var feed map[string]interface{}
	if err := json.Unmarshal(out, &feed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	entity := feed["entity"].([]interface{})[0].(map[string]interface{})
	vehicle := entity["vehicle"].(map[string]interface{})
	trip := vehicle["trip"].(map[string]interface{})

	if trip["tripInfoFound"] != true {
		t.Fatalf("expected tripInfoFound, got %v", trip["tripInfoFound"])
	}
	if trip["tripHeadsign"] == "" {
		t.Fatalf("expected tripHeadsign to be enriched")
	}
	if trip["shapeId"] == "" {
		t.Fatalf("expected shapeId to be enriched")
	}
	if vehicle["routeShortName"] == "" {
		t.Fatalf("expected routeShortName to be enriched")
	}
}

func TestStopDepartures(t *testing.T) {
	datafeedsDir = filepath.Join("data", "gtfs")

	// Pure, and worth checking whether or not an archive is present: GTFS times run past
	// 24:00:00 and mishandling that is silent.
	if got := parseGTFSSeconds("25:10:05"); got != 25*3600+10*60+5 {
		t.Fatalf("parseGTFSSeconds(25:10:05) = %d", got)
	}

	requireGTFS(t)

	now := time.Now().In(loadAgencyTimezone())
	if len(todaysServiceIDs(now)) == 0 {
		t.Fatalf("expected active services today, calendar parsing is broken")
	}

	// Sample real served stop IDs from stop_times.txt; stops.json starts
	// with MTC placeholder hubs that have no scheduled service here.
	file, err := os.Open(filepath.Join(datafeedsDir, "stop_times.txt"))
	if err != nil {
		t.Skipf("no stop_times.txt available: %v", err)
	}
	defer file.Close()
	r := csv.NewReader(file)
	r.FieldsPerRecord = -1
	if _, err := r.Read(); err != nil {
		t.Skipf("empty stop_times.txt: %v", err)
	}
	stopIDs := make(map[string]bool)
	for len(stopIDs) < 5 {
		rec, err := r.Read()
		if err != nil {
			break
		}
		if id := rec[1]; id != "" {
			stopIDs[id] = true
		}
	}

	found := false
	for s := range stopIDs {
		deps := stopDepartures(map[string]bool{s: true}, 30)
		if len(deps) > 30 {
			t.Fatalf("expected at most 30 departures, got %d", len(deps))
		}
		var last int64
		for _, d := range deps {
			ts := d["departure_timestamp"].(int64)
			if ts < last {
				t.Fatalf("departures not sorted ascending")
			}
			last = ts
			if d["route_short_name"] == "" || d["trip_headsign"] == "" {
				t.Fatalf("expected enriched departure fields, got %+v", d)
			}
		}
		if len(deps) > 0 {
			found = true
			break
		}
	}
	// Owl-hours dead zone (midnight-6am local): no upcoming departures is valid.
	if now.Hour() >= 0 && now.Hour() < 6 {
		found = true
	}
	if !found {
		t.Fatalf("no departures found for any sampled stop during daytime hours")
	}
}

func TestStopGroups(t *testing.T) {
	datafeedsDir = filepath.Join("data", "gtfs")
	requireGTFS(t)

	groups := loadStopGroups()
	if len(groups) == 0 {
		t.Fatalf("expected stop groups, got none")
	}

	merged := 0
	for _, g := range groups {
		if len(g.Members) > 1 {
			merged++
			if g.Name == "" || g.Lat == 0 || g.Lon == 0 {
				t.Fatalf("group %s missing name/coords: %+v", g.GroupID, g)
			}
		}
	}
	if merged == 0 {
		t.Fatalf("expected at least one multi-stop station group")
	}
	t.Logf("%d groups, %d with multiple stops", len(groups), merged)
}
