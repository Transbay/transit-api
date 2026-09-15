package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/graphql-go/graphql"
)

var gqlSchema graphql.Schema

var regionArg = graphql.FieldConfigArgument{
	"region": &graphql.ArgumentConfig{Type: graphql.String},
}

func isSeattle(p graphql.ResolveParams) bool {
	r, _ := p.Args["region"].(string)
	return r == "seattle" || r == "sound-transit"
}

func isSacrt(p graphql.ResolveParams) bool {
	r, _ := p.Args["region"].(string)
	return r == "sacrt"
}

func isElk(p graphql.ResolveParams) bool {
	r, _ := p.Args["region"].(string)
	return r == "elk"
}


var tripsCache []interface{}
var tripsCacheMu sync.RWMutex

func invalidateTripsCache() {
	tripsCacheMu.Lock()
	tripsCache = nil
	tripsCacheMu.Unlock()
}

func init() {
	q := graphql.NewObject(graphql.ObjectConfig{
		Name: "Query",
		Fields: graphql.Fields{
			"agencies":   &graphql.Field{Type: graphql.NewList(agencyType), Args: regionArg, Resolve: resolveAgencies},
			"routes":     &graphql.Field{Type: graphql.NewList(routeType), Args: regionArg, Resolve: resolveRoutes},
			"stops":      &graphql.Field{Type: graphql.NewList(stopType), Args: regionArg, Resolve: resolveStops},
			"stopGroups": &graphql.Field{Type: graphql.NewList(stopGroupType), Args: regionArg, Resolve: resolveStopGroups},
			"stop": &graphql.Field{
				Type: stopDetailType,
				Args: graphql.FieldConfigArgument{
					"stopId": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
					"region": &graphql.ArgumentConfig{Type: graphql.String},
				},
				Resolve: resolveStop,
			},
			"trips":       &graphql.Field{Type: graphql.NewList(tripRowType), Args: regionArg, Resolve: resolveTrips},
			"vehicleFeed": &graphql.Field{Type: vehicleFeedEnvelopeType, Args: regionArg, Resolve: resolveVehicleFeed},
			"tripDetail": &graphql.Field{
				Type: tripDetailType,
				Args: graphql.FieldConfigArgument{
					"tripId": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
					"region": &graphql.ArgumentConfig{Type: graphql.String},
				},
				Resolve: resolveTripDetail,
			},
			"shape": &graphql.Field{
				Type: graphql.NewList(graphql.NewList(graphql.Float)),
				Args: graphql.FieldConfigArgument{
					"shapeId": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
					"region":  &graphql.ArgumentConfig{Type: graphql.String},
				},
				Resolve: resolveShape,
			},
		},
	})

	var err error
	gqlSchema, err = graphql.NewSchema(graphql.SchemaConfig{Query: q})
	if err != nil {
		log.Fatalf("graphql schema: %v", err)
	}
}

func graphQLHandler(w http.ResponseWriter, r *http.Request) {
	var params struct {
		Query         string                 `json:"query"`
		OperationName string                 `json:"operationName"`
		Variables     map[string]interface{} `json:"variables"`
	}
	if err := json.NewDecoder(r.Body).Decode(&params); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	result := graphql.Do(graphql.Params{
		Schema:         gqlSchema,
		RequestString:  params.Query,
		VariableValues: params.Variables,
		OperationName:  params.OperationName,
	})

	w.Header().Set("Content-Type", "application/json")
	if len(result.Errors) > 0 {
		w.WriteHeader(http.StatusBadRequest)
	}
	json.NewEncoder(w).Encode(result)
}

// vehicle feed types
var vehicleFeedEnvelopeType = graphql.NewObject(graphql.ObjectConfig{
	Name: "VehicleFeedEnvelope",
	Fields: graphql.Fields{
		"fetchedAt": &graphql.Field{Type: graphql.String},
		"data":      &graphql.Field{Type: vehicleFeedDataType},
	},
})

var vehicleFeedDataType = graphql.NewObject(graphql.ObjectConfig{
	Name: "VehicleFeedData",
	Fields: graphql.Fields{
		"entity": &graphql.Field{Type: graphql.NewList(entityType)},
	},
})

var entityType = graphql.NewObject(graphql.ObjectConfig{
	Name: "Entity",
	Fields: graphql.Fields{
		"id": &graphql.Field{Type: graphql.String},
		"vehicle": &graphql.Field{
			Type: vehicleDataType,
			Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				m, _ := p.Source.(map[string]interface{})
				return m["vehicle"], nil
			},
		},
	},
})

var vehicleDataType = graphql.NewObject(graphql.ObjectConfig{
	Name: "VehicleData",
	Fields: graphql.Fields{
		"trip": &graphql.Field{
			Type: tripDataType,
			Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				m, _ := p.Source.(map[string]interface{})
				return m["trip"], nil
			},
		},
		"position": &graphql.Field{
			Type: positionType,
			Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				m, _ := p.Source.(map[string]interface{})
				return m["position"], nil
			},
		},
		"timestamp":           &graphql.Field{Type: graphql.Int},
		"stopId":              &graphql.Field{Type: graphql.String},
		"currentStopSequence": &graphql.Field{Type: graphql.Int},
		"occupancyStatus":     &graphql.Field{Type: graphql.String},
		"stopName":            &graphql.Field{Type: graphql.String},
		"vehicle": &graphql.Field{
			Type: vehicleDescriptorType,
			Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				m, _ := p.Source.(map[string]interface{})
				return m["vehicle"], nil
			},
		},
		"vehicleYear":   &graphql.Field{Type: graphql.Int},
		"vehicleMake":   &graphql.Field{Type: graphql.String},
		"vehicleModel":  &graphql.Field{Type: graphql.String},
		"vehicleFuel":   &graphql.Field{Type: graphql.String},
		"vehicleLength": &graphql.Field{Type: graphql.Int},
		"vehicleIconCode": &graphql.Field{
			Type: graphql.String,
			Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				m, _ := p.Source.(map[string]interface{})
				if v, ok := m["vehicleIconCode"]; ok {
					return v, nil
				}
				return m["icon_code"], nil
			},
		},
		"routeShortName": &graphql.Field{Type: graphql.String},
	},
})

var tripDataType = graphql.NewObject(graphql.ObjectConfig{
	Name: "TripData",
	Fields: graphql.Fields{
		"tripId":               &graphql.Field{Type: graphql.String},
		"routeId":              &graphql.Field{Type: graphql.String},
		"directionId":          &graphql.Field{Type: graphql.Int},
		"delay":                &graphql.Field{Type: graphql.Int},
		"startTime":            &graphql.Field{Type: graphql.String},
		"startDate":            &graphql.Field{Type: graphql.String},
		"scheduleRelationship": &graphql.Field{Type: graphql.String},
		"tripInfoFound":        &graphql.Field{Type: graphql.Boolean},
		"tripHeadsign":         &graphql.Field{Type: graphql.String},
		"serviceId":            &graphql.Field{Type: graphql.String},
		"shapeId":              &graphql.Field{Type: graphql.String},
		"blockId":              &graphql.Field{Type: graphql.String},
		"tripShortName":        &graphql.Field{Type: graphql.String},
	},
})

var positionType = graphql.NewObject(graphql.ObjectConfig{
	Name: "Position",
	Fields: graphql.Fields{
		"latitude":  &graphql.Field{Type: graphql.Float},
		"longitude": &graphql.Field{Type: graphql.Float},
		"bearing":   &graphql.Field{Type: graphql.Float},
		"speed":     &graphql.Field{Type: graphql.Float},
	},
})

var vehicleDescriptorType = graphql.NewObject(graphql.ObjectConfig{
	Name: "VehicleDescriptor",
	Fields: graphql.Fields{
		"id":    &graphql.Field{Type: graphql.String},
		"label": &graphql.Field{Type: graphql.String},
	},
})

// GTFS types
var agencyType = graphql.NewObject(graphql.ObjectConfig{
	Name: "Agency",
	Fields: graphql.Fields{
		"agency_id":       &graphql.Field{Type: graphql.String},
		"agency_name":     &graphql.Field{Type: graphql.String},
		"agency_url":      &graphql.Field{Type: graphql.String},
		"agency_timezone": &graphql.Field{Type: graphql.String},
		"agency_lang":     &graphql.Field{Type: graphql.String},
		"agency_phone":    &graphql.Field{Type: graphql.String},
		"agency_fare_url": &graphql.Field{Type: graphql.String},
		"agency_email":    &graphql.Field{Type: graphql.String},
	},
})

var routeType = graphql.NewObject(graphql.ObjectConfig{
	Name: "Route",
	Fields: graphql.Fields{
		"route_id":         &graphql.Field{Type: graphql.String},
		"agency_id":        &graphql.Field{Type: graphql.String},
		"route_short_name": &graphql.Field{Type: graphql.String},
		"route_long_name":  &graphql.Field{Type: graphql.String},
		"route_type":       &graphql.Field{Type: graphql.String},
		"route_color":      &graphql.Field{Type: graphql.String},
		"route_text_color": &graphql.Field{Type: graphql.String},
		"route_url":        &graphql.Field{Type: graphql.String},
		"route_desc":       &graphql.Field{Type: graphql.String},
	},
})

var stopType = graphql.NewObject(graphql.ObjectConfig{
	Name: "Stop",
	Fields: graphql.Fields{
		"stop_id":   &graphql.Field{Type: graphql.String},
		"stop_name": &graphql.Field{Type: graphql.String},
		"stop_lat":  &graphql.Field{Type: graphql.String},
		"stop_lon":  &graphql.Field{Type: graphql.String},
	},
})

var departureType = graphql.NewObject(graphql.ObjectConfig{
	Name: "Departure",
	Fields: graphql.Fields{
		"trip_id":             &graphql.Field{Type: graphql.String},
		"route_id":            &graphql.Field{Type: graphql.String},
		"route_short_name":    &graphql.Field{Type: graphql.String},
		"trip_headsign":       &graphql.Field{Type: graphql.String},
		"direction_id":        &graphql.Field{Type: graphql.String},
		"arrival_time":        &graphql.Field{Type: graphql.String},
		"departure_time":      &graphql.Field{Type: graphql.String},
		"departure_timestamp": &graphql.Field{Type: graphql.Int},
	},
})

var stopDetailType = graphql.NewObject(graphql.ObjectConfig{
	Name: "StopDetail",
	Fields: graphql.Fields{
		"stop_id":    &graphql.Field{Type: graphql.String},
		"stop_name":  &graphql.Field{Type: graphql.String},
		"stop_lat":   &graphql.Field{Type: graphql.String},
		"stop_lon":   &graphql.Field{Type: graphql.String},
		"departures": &graphql.Field{Type: graphql.NewList(departureType)},
	},
})

var stopGroupType = graphql.NewObject(graphql.ObjectConfig{
	Name: "StopGroup",
	Fields: graphql.Fields{
		"group_id":   &graphql.Field{Type: graphql.String},
		"group_name": &graphql.Field{Type: graphql.String},
		"stop_lat":   &graphql.Field{Type: graphql.Float},
		"stop_lon":   &graphql.Field{Type: graphql.Float},
		"route_id":   &graphql.Field{Type: graphql.String},
	},
})

var tripRowType = graphql.NewObject(graphql.ObjectConfig{
	Name: "Trip",
	Fields: graphql.Fields{
		"trip_id":               &graphql.Field{Type: graphql.String},
		"route_id":              &graphql.Field{Type: graphql.String},
		"service_id":            &graphql.Field{Type: graphql.String},
		"trip_headsign":         &graphql.Field{Type: graphql.String},
		"direction_id":          &graphql.Field{Type: graphql.String},
		"shape_id":              &graphql.Field{Type: graphql.String},
		"block_id":              &graphql.Field{Type: graphql.String},
		"trip_short_name":       &graphql.Field{Type: graphql.String},
		"wheelchair_accessible": &graphql.Field{Type: graphql.String},
		"bikes_allowed":         &graphql.Field{Type: graphql.String},
	},
})

// trip detail types
var tripDetailType = graphql.NewObject(graphql.ObjectConfig{
	Name: "TripDetail",
	Fields: graphql.Fields{
		"trip_id":         &graphql.Field{Type: graphql.String},
		"route_id":        &graphql.Field{Type: graphql.String},
		"service_id":      &graphql.Field{Type: graphql.String},
		"trip_headsign":   &graphql.Field{Type: graphql.String},
		"direction_id":    &graphql.Field{Type: graphql.String},
		"shape_id":        &graphql.Field{Type: graphql.String},
		"block_id":        &graphql.Field{Type: graphql.String},
		"trip_short_name": &graphql.Field{Type: graphql.String},
		"shape":           &graphql.Field{Type: graphql.NewList(graphql.NewList(graphql.Float))},
		"schedule":        &graphql.Field{Type: graphql.NewList(stopTimeType)},
	},
})

var stopTimeType = graphql.NewObject(graphql.ObjectConfig{
	Name: "StopTime",
	Fields: graphql.Fields{
		"stop_id":        &graphql.Field{Type: graphql.String},
		"stop_sequence":  &graphql.Field{Type: graphql.Int},
		"arrival_time":   &graphql.Field{Type: graphql.String},
		"departure_time": &graphql.Field{Type: graphql.String},
		"stop_name":      &graphql.Field{Type: graphql.String},
		"stop_lat":       &graphql.Field{Type: graphql.String},
		"stop_lon":       &graphql.Field{Type: graphql.String},
	},
})

// resolvers
func resolveAgencies(p graphql.ResolveParams) (interface{}, error) {
	if isSeattle(p) {
		return seattle.readAgencyJSON(), nil
	}
	if isSacrt(p) {
		return sacrt.readAgencyJSON(), nil
	}
	if isElk(p) {
		return elk.readAgencyJSON(), nil
	}
	path := filepath.Join(tripDataDir, "agency.json")
	return readJSONArray(path)
}

func resolveRoutes(p graphql.ResolveParams) (interface{}, error) {
	if isSeattle(p) {
		return seattle.readRoutes(), nil
	}
	if isSacrt(p) {
		return sacrt.readRoutes(), nil
	}
	if isElk(p) {
		return elk.readRoutes(), nil
	}
	path := filepath.Join(tripDataDir, "routes.json")
	return readJSONArray(path)
}

func resolveStops(p graphql.ResolveParams) (interface{}, error) {
	if isSeattle(p) {
		return seattle.readStops(), nil
	}
	if isSacrt(p) {
		return sacrt.readStops(), nil
	}
	if isElk(p) {
		return elk.readStops(), nil
	}
	path := filepath.Join(tripDataDir, "stops.json")
	return readJSONArray(path)
}

func resolveStopGroups(p graphql.ResolveParams) (interface{}, error) {
	groups := loadStopGroups()
	if isSeattle(p) {
		groups = seattle.loadStopGroups()
	}
	if isSacrt(p) {
		groups = sacrt.loadStopGroups()
	}
	if isElk(p) {
		groups = elk.loadStopGroups()
	}
	out := make([]interface{}, 0, len(groups))
	for _, g := range groups {
		out = append(out, map[string]interface{}{
			"group_id":   g.GroupID,
			"group_name": g.Name,
			"stop_lat":   g.Lat,
			"stop_lon":   g.Lon,
			"route_id":   g.RouteID,
		})
	}
	return out, nil
}

func resolveStop(p graphql.ResolveParams) (interface{}, error) {
	stopID, _ := p.Args["stopId"].(string)
	if stopID == "" {
		return nil, nil
	}

	if isSeattle(p) {
		if group, ok := seattle.loadStopGroups()[stopID]; ok && len(group.Members) > 0 {
			members := make(map[string]bool, len(group.Members))
			for _, id := range group.Members {
				members[id] = true
			}
			return map[string]interface{}{
				"stop_id":    stopID,
				"stop_name":  group.Name,
				"stop_lat":   strconv.FormatFloat(group.Lat, 'f', -1, 64),
				"stop_lon":   strconv.FormatFloat(group.Lon, 'f', -1, 64),
				"departures": seattle.departures(members, 30),
			}, nil
		}
		stop, ok := seattle.loadStops()[stopID]
		if !ok {
			return nil, nil
		}
		return map[string]interface{}{
			"stop_id":    stop.stop_id,
			"stop_name":  stop.stop_name,
			"stop_lat":   stop.stop_lat,
			"stop_lon":   stop.stop_lon,
			"departures": seattle.departures(map[string]bool{stopID: true}, 30),
		}, nil
	}

	if isSacrt(p) {
		if group, ok := sacrt.loadStopGroups()[stopID]; ok && len(group.Members) > 0 {
			members := make(map[string]bool, len(group.Members))
			for _, id := range group.Members {
				members[id] = true
			}
			return map[string]interface{}{
				"stop_id":    stopID,
				"stop_name":  group.Name,
				"stop_lat":   strconv.FormatFloat(group.Lat, 'f', -1, 64),
				"stop_lon":   strconv.FormatFloat(group.Lon, 'f', -1, 64),
				"departures": sacrt.departures(members, 30),
			}, nil
		}
		stop, ok := sacrt.loadStops()[stopID]
		if !ok {
			return nil, nil
		}
		return map[string]interface{}{
			"stop_id":    stop.stop_id,
			"stop_name":  stop.stop_name,
			"stop_lat":   stop.stop_lat,
			"stop_lon":   stop.stop_lon,
			"departures": sacrt.departures(map[string]bool{stopID: true}, 30),
		}, nil
	}

	if isElk(p) {
		if group, ok := elk.loadStopGroups()[stopID]; ok && len(group.Members) > 0 {
			members := make(map[string]bool, len(group.Members))
			for _, id := range group.Members {
				members[id] = true
			}
			return map[string]interface{}{
				"stop_id":    stopID,
				"stop_name":  group.Name,
				"stop_lat":   strconv.FormatFloat(group.Lat, 'f', -1, 64),
				"stop_lon":   strconv.FormatFloat(group.Lon, 'f', -1, 64),
				"departures": elk.departures(members, 30),
			}, nil
		}
		stop, ok := elk.loadStops()[stopID]
		if !ok {
			return nil, nil
		}
		return map[string]interface{}{
			"stop_id":    stop.stop_id,
			"stop_name":  stop.stop_name,
			"stop_lat":   stop.stop_lat,
			"stop_lon":   stop.stop_lon,
			"departures": elk.departures(map[string]bool{stopID: true}, 30),
		}, nil
	}

	// Station group: merge departures across all member stops.
	if group, ok := loadStopGroups()[stopID]; ok && len(group.Members) > 0 {
		members := make(map[string]bool, len(group.Members))
		for _, id := range group.Members {
			members[id] = true
		}
		return map[string]interface{}{
			"stop_id":    stopID,
			"stop_name":  group.Name,
			"stop_lat":   strconv.FormatFloat(group.Lat, 'f', -1, 64),
			"stop_lon":   strconv.FormatFloat(group.Lon, 'f', -1, 64),
			"departures": stopDepartures(members, 30),
		}, nil
	}

	stop, ok := loadStopsData()[stopID]
	if !ok {
		return nil, nil
	}
	return map[string]interface{}{
		"stop_id":    stop.stop_id,
		"stop_name":  stop.stop_name,
		"stop_lat":   stop.stop_lat,
		"stop_lon":   stop.stop_lon,
		"departures": stopDepartures(map[string]bool{stopID: true}, 30),
	}, nil
}

func resolveTrips(p graphql.ResolveParams) (interface{}, error) {
	if isSeattle(p) {
		trips := seattle.loadTrips()
		return tripsToResult(trips), nil
	}
	if isSacrt(p) {
		trips := sacrt.loadTrips()
		return tripsToResult(trips), nil
	}
	if isElk(p) {
		trips := elk.loadTrips()
		return tripsToResult(trips), nil
	}

	tripsCacheMu.RLock()
	if tripsCache != nil {
		defer tripsCacheMu.RUnlock()
		return tripsCache, nil
	}
	tripsCacheMu.RUnlock()

	tripsCacheMu.Lock()
	defer tripsCacheMu.Unlock()
	if tripsCache != nil {
		return tripsCache, nil
	}

	trips := loadTripsData()
	result := tripsToResult(trips)
	tripsCache = result
	return result, nil
}

func tripsToResult(trips map[string]TripInfo) []interface{} {
	result := make([]interface{}, 0, len(trips))
	for _, t := range trips {
		result = append(result, map[string]interface{}{
			"trip_id":               t.trip_id,
			"route_id":              t.route_id,
			"service_id":            t.service_id,
			"trip_headsign":         t.trip_headsign,
			"direction_id":          t.direction_id,
			"shape_id":              t.shape_id,
			"block_id":              t.block_id,
			"trip_short_name":       t.trip_short_name,
			"wheelchair_accessible": t.wheelchair_accessible,
			"bikes_allowed":         t.bikes_allowed,
		})
	}
	return result
}

func resolveVehicleFeed(p graphql.ResolveParams) (interface{}, error) {
	if isSeattle(p) {
		parsed, t := seattle.vehicles()
		if parsed == nil {
			return nil, nil
		}
		return map[string]interface{}{
			"fetchedAt": t.UTC().Format(time.RFC3339Nano),
			"data":      parsed,
		}, nil
	}

	if isSacrt(p) {
		parsed, t := sacrt.vehicles()
		if parsed == nil {
			return nil, nil
		}
		return map[string]interface{}{
			"fetchedAt": t.UTC().Format(time.RFC3339Nano),
			"data":      parsed,
		}, nil
	}

	if isElk(p) {
		parsed, t := elk.vehicles()
		if parsed == nil {
			return nil, nil
		}
		return map[string]interface{}{
			"fetchedAt": t.UTC().Format(time.RFC3339Nano),
			"data":      parsed,
		}, nil
	}

	vehiclePositionsCacheMu.RLock()
	parsed := vehiclePositionsCacheParsed
	cacheTime := vehiclePositionsCacheTime
	vehiclePositionsCacheMu.RUnlock()

	if parsed == nil {
		return nil, nil
	}

	return map[string]interface{}{
		"fetchedAt": cacheTime.UTC().Format(time.RFC3339Nano),
		"data":      parsed,
	}, nil
}

func resolveTripDetail(p graphql.ResolveParams) (interface{}, error) {
	tripID, _ := p.Args["tripId"].(string)
	if tripID == "" {
		return nil, nil
	}

	if isSeattle(p) {
		return seattleTripDetail(tripID)
	}

	if isSacrt(p) {
		return sacrtTripDetail(tripID)
	}

	if isElk(p) {
		return elkTripDetail(tripID)
	}

	// Try pre-computed file first
	if tripDetailsDir != "" {
		tripPath := filepath.Join(tripDetailsDir, tripID+".json")
		if data, err := os.ReadFile(tripPath); err == nil {
			var result map[string]interface{}
			if err := json.Unmarshal(data, &result); err == nil {
				return result, nil
			}
		}
	}

	// Build from GTFS data
	trips := loadTripsData()
	stops := loadStopsData()

	trip, ok := trips[tripID]
	if !ok {
		return nil, nil
	}

	times := loadStopTimesForTrip(tripID)
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
		coords, err := loadShapeForTrip(trip.shape_id)
		if err == nil {
			shapeCoords = coords
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

func resolveShape(p graphql.ResolveParams) (interface{}, error) {
	shapeID, _ := p.Args["shapeId"].(string)
	if shapeID == "" {
		return [][]float64{}, nil
	}

	var coords [][2]float64
	if isSeattle(p) {
		c, err := seattle.shapeForTrip(shapeID)
		if err != nil || c == nil {
			return [][]float64{}, nil
		}
		coords = c
	} else if isSacrt(p) {
		c, err := sacrt.shapeForTrip(shapeID)
		if err != nil || c == nil {
			return [][]float64{}, nil
		}
		coords = c
	} else if isElk(p) {
		c, err := elk.shapeForTrip(shapeID)
		if err != nil || c == nil {
			return [][]float64{}, nil
		}
		coords = c
	} else {
		c, err := loadShapeForTrip(shapeID)
		if err != nil || c == nil {
			return [][]float64{}, nil
		}
		coords = c
	}

	shape := make([][]float64, len(coords))
	for i, c := range coords {
		shape[i] = []float64{c[0], c[1]}
	}
	return shape, nil
}

// seattleTripDetail builds a trip detail (schedule + shape) from the Seattle
// region GTFS, without the pre-computed file layer.
func seattleTripDetail(tripID string) (interface{}, error) {
	trips := seattle.loadTrips()
	trip, ok := trips[stripObaPrefix(tripID)]
	if !ok {
		return nil, nil
	}
	gTripID := stripObaPrefix(tripID)
	stops := seattle.loadStops()
	times := seattle.stopTimesForTrip(gTripID)
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
		if c, err := seattle.shapeForTrip(trip.shape_id); err == nil {
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

func readJSONArray(path string) ([]interface{}, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return []interface{}{}, nil
	}
	var arr []interface{}
	if err := json.Unmarshal(data, &arr); err != nil {
		return []interface{}{}, nil
	}
	return arr, nil
}
