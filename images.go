package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/bsontype"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

type VehicleImage struct {
	ID          primitive.ObjectID `bson:"_id,omitempty" json:"id"`
	VehicleID   string             `bson:"vehicle_id" json:"vehicle_id"`
	AgencyCode  string             `bson:"agency_code,omitempty" json:"agency_code,omitempty"`
	ImageURL    string             `bson:"image_url" json:"image_url"`
	ImageData   primitive.Binary   `bson:"image_data,omitempty" json:"-"`
	ContentType string             `bson:"content_type,omitempty" json:"-"`
	Attribution string             `bson:"attribution,omitempty" json:"attribution,omitempty"`
	Description string             `bson:"description,omitempty" json:"description,omitempty"`
	UploadedAt  time.Time          `bson:"uploaded_at" json:"uploaded_at"`
}

const maxUploadBytes = 10 << 20 // 10 MB

func uploadableContentType(ct string) bool {
	switch ct {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return true
	}
	return false
}

type createImageRequest struct {
	ImageURL    string `json:"image_url"`
	VehicleID   string `json:"vehicle_id"`
	AgencyCode  string `json:"agency_code,omitempty"`
	Attribution string `json:"attribution,omitempty"`
	Description string `json:"description,omitempty"`
}

var (
	mongoClient      *mongo.Client
	imagesCollection *mongo.Collection
)

func initMongoDB() error {
	uri := os.Getenv("MONGODB_URI")
	if uri == "" {
		uri = os.Getenv("MONGO_URI")
	}
	if uri == "" {
		uri = "mongodb://localhost:27017"
	}

	client, err := mongo.Connect(context.Background(), options.Client().ApplyURI(uri))
	if err != nil {
		return fmt.Errorf("mongo connect: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Ping(ctx, nil); err != nil {
		return fmt.Errorf("mongo ping: %w", err)
	}

	mongoClient = client
	db := client.Database("headways")
	imagesCollection = db.Collection("vehicle_images")

	log.Println("Connected to MongoDB")
	return nil
}

func closeMongoDB() {
	if mongoClient != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = mongoClient.Disconnect(ctx)
	}
}

func createImageHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if imagesCollection == nil {
		http.Error(w, "MongoDB is not connected. Check server logs for connection error.", http.StatusServiceUnavailable)
		return
	}

	vehID, agency, attribution, description := "", "", "", ""
	var imageURL string
	var imageData []byte
	var contentType string
	hasFile := false

	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
		if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
			http.Error(w, fmt.Sprintf("failed to parse upload: %v", err), http.StatusBadRequest)
			return
		}
		vehID = r.FormValue("vehicle_id")
		agency = r.FormValue("agency_code")
		attribution = r.FormValue("attribution")
		description = r.FormValue("description")
		file, header, err := r.FormFile("file")
		if err != nil {
			http.Error(w, "file is required", http.StatusBadRequest)
			return
		}
		defer file.Close()
		if !uploadableContentType(header.Header.Get("Content-Type")) {
			http.Error(w, "unsupported file type; use JPEG, PNG, GIF, or WebP", http.StatusUnsupportedMediaType)
			return
		}
		imageData, err = io.ReadAll(file)
		if err != nil {
			http.Error(w, fmt.Sprintf("failed to read file: %v", err), http.StatusInternalServerError)
			return
		}
		contentType = header.Header.Get("Content-Type")
		hasFile = true
	} else {
		var req createImageRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, fmt.Sprintf("invalid JSON: %v", err), http.StatusBadRequest)
			return
		}
		vehID, agency = req.VehicleID, req.AgencyCode
		attribution = req.Attribution
		description = req.Description
		imageURL = req.ImageURL
	}

	if vehID == "" {
		http.Error(w, "vehicle_id is required", http.StatusBadRequest)
		return
	}
	if !hasFile && imageURL == "" {
		http.Error(w, "image_url is required", http.StatusBadRequest)
		return
	}

	img := VehicleImage{
		VehicleID:   vehID,
		AgencyCode:  agency,
		ImageURL:    imageURL,
		ImageData:   primitive.Binary{Data: imageData, Subtype: bsontype.BinaryGeneric},
		ContentType: contentType,
		Attribution: attribution,
		Description: description,
		UploadedAt:  time.Now(),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	result, err := imagesCollection.InsertOne(ctx, img)
	if err != nil {
		log.Printf("mongo insert failed: %v", err)
		http.Error(w, fmt.Sprintf("failed to store image record: %v", err), http.StatusInternalServerError)
		return
	}

	img.ID = result.InsertedID.(primitive.ObjectID)
	if hasFile {
		img.ImageURL = "/api/images/file/" + img.ID.Hex()
		if _, err := imagesCollection.UpdateOne(ctx, bson.M{"_id": img.ID},
			bson.M{"$set": bson.M{"image_url": img.ImageURL}}); err != nil {
			log.Printf("mongo update image_url failed: %v", err)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(img)
}

func serveImageFileHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if imagesCollection == nil {
		http.Error(w, "MongoDB is not connected", http.StatusServiceUnavailable)
		return
	}
	idStr := r.PathValue("id")
	objID, err := primitive.ObjectIDFromHex(idStr)
	if err != nil {
		http.Error(w, "invalid image id", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var img VehicleImage
	if err := imagesCollection.FindOne(ctx, bson.M{"_id": objID}).Decode(&img); err != nil {
		http.Error(w, "image not found", http.StatusNotFound)
		return
	}
	if len(img.ImageData.Data) == 0 {
		http.Error(w, "image has no uploaded file", http.StatusNotFound)
		return
	}
	ct := img.ContentType
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Write(img.ImageData.Data)
}

func vehicleImagesHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if imagesCollection == nil {
		http.Error(w, "MongoDB is not connected", http.StatusServiceUnavailable)
		return
	}

	vehicleID := r.PathValue("vehicle_id")
	if vehicleID == "" {
		http.Error(w, "vehicle_id is required", http.StatusBadRequest)
		return
	}

	// Vehicle ids collide across agencies (e.g. DB:211 vs WC:211), so an
	// optional agency code scopes the lookup.
	filter := bson.M{"vehicle_id": vehicleID}
	if agency := r.URL.Query().Get("agency"); agency != "" {
		filter["agency_code"] = agency
	}
	opts := options.Find().SetSort(bson.M{"uploaded_at": -1})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cursor, err := imagesCollection.Find(ctx, filter, opts)
	if err != nil {
		log.Printf("mongo find failed: %v", err)
		http.Error(w, fmt.Sprintf("failed to query images: %v", err), http.StatusInternalServerError)
		return
	}
	defer cursor.Close(ctx)

	var images []VehicleImage
	if err := cursor.All(ctx, &images); err != nil {
		log.Printf("mongo cursor decode failed: %v", err)
		http.Error(w, fmt.Sprintf("failed to decode results: %v", err), http.StatusInternalServerError)
		return
	}

	if images == nil {
		images = []VehicleImage{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(images)
}

func deleteImageHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if imagesCollection == nil {
		http.Error(w, "MongoDB is not connected", http.StatusServiceUnavailable)
		return
	}

	idStr := r.PathValue("id")
	if idStr == "" {
		http.Error(w, "id is required", http.StatusBadRequest)
		return
	}

	objID, err := primitive.ObjectIDFromHex(idStr)
	if err != nil {
		http.Error(w, "invalid image id", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	result, err := imagesCollection.DeleteOne(ctx, bson.M{"_id": objID})
	if err != nil {
		log.Printf("mongo delete failed: %v", err)
		http.Error(w, fmt.Sprintf("failed to delete image: %v", err), http.StatusInternalServerError)
		return
	}

	if result.DeletedCount == 0 {
		http.Error(w, "image not found", http.StatusNotFound)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func vehicleImagesListHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if imagesCollection == nil {
		http.Error(w, "MongoDB is not connected", http.StatusServiceUnavailable)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	opts := options.Find().SetSort(bson.M{"uploaded_at": -1}).SetLimit(50)
	cursor, err := imagesCollection.Find(ctx, bson.M{}, opts)
	if err != nil {
		log.Printf("mongo list all failed: %v", err)
		http.Error(w, "failed to query images", http.StatusInternalServerError)
		return
	}
	defer cursor.Close(ctx)

	var images []VehicleImage
	if err := cursor.All(ctx, &images); err != nil {
		log.Printf("mongo cursor decode failed: %v", err)
		http.Error(w, "failed to decode results", http.StatusInternalServerError)
		return
	}

	if images == nil {
		images = []VehicleImage{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(images)
}

func vehicleIdsWithImagesHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if imagesCollection == nil {
		http.Error(w, "MongoDB is not connected", http.StatusServiceUnavailable)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Distinct (vehicle_id, agency_code) pairs, so the client can key images
	// by a unique identifyer instead of the colliding bare vehicle id.
	pipeline := bson.A{
		bson.M{"$group": bson.M{"_id": bson.M{"vehicle_id": "$vehicle_id", "agency_code": "$agency_code"}}},
	}
	cursor, err := imagesCollection.Aggregate(ctx, pipeline)
	if err != nil {
		log.Printf("mongo aggregate failed: %v", err)
		http.Error(w, "failed to query images", http.StatusInternalServerError)
		return
	}
	defer cursor.Close(ctx)
	var keys []map[string]string
	for cursor.Next(ctx) {
		var row struct {
			ID struct {
				VehicleID  string `bson:"vehicle_id"`
				AgencyCode string `bson:"agency_code"`
			} `bson:"_id"`
		}
		if err := cursor.Decode(&row); err != nil {
			log.Printf("mongo cursor decode failed: %v", err)
			continue
		}
		keys = append(keys, map[string]string{
			"vehicle_id":  row.ID.VehicleID,
			"agency_code": row.ID.AgencyCode,
		})
	}
	if keys == nil {
		keys = []map[string]string{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(keys)
}

func imageUploadPageHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Headways - Add Vehicle Photo</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f9fafb; color: #111827; }
  h1 { font-size: 24px; margin-bottom: 20px; }
  form { background: white; padding: 24px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  label { display: block; font-weight: 600; margin-top: 16px; margin-bottom: 4px; font-size: 14px; color: #374151; }
  input, textarea { width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; box-sizing: border-box; }
  textarea { resize: vertical; font-family: inherit; }
  button { margin-top: 20px; background: #2563eb; color: white; border: none; padding: 10px 20px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; width: 100%; }
  button:hover { background: #1d4ed8; }
  .msg { margin-top: 16px; padding: 12px; border-radius: 8px; display: none; }
  .msg.success { display: block; background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }
  .msg.error { display: block; background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
  .help { font-size: 12px; color: #9ca3af; margin-top: 4px; }
</style>
</head>
<body>
  <h1>Add Vehicle Photo</h1>
  <form id="uploadForm">
    <label for="vehicle_id">Vehicle ID *</label>
    <input type="text" id="vehicle_id" name="vehicle_id" required placeholder="e.g. 1015 or vehicle unique_id">
    <div class="help">The vehicle ID shown in the popup</div>

    <label for="image_url">Image URL *</label>
    <input type="url" id="image_url" name="image_url" required placeholder="https://example.com/photo.jpg">
    <div class="help">Direct link to the vehicle photo</div>

    <label for="agency_code">Agency Code</label>
    <input type="text" id="agency_code" name="agency_code" placeholder="e.g. SF, AC, VTA">

    <label for="attribution">Attribution</label>
    <input type="text" id="attribution" name="attribution" placeholder="e.g. Photo by John Doe">

    <label for="description">Description</label>
    <textarea id="description" name="description" rows="2" placeholder="Optional description"></textarea>

    <button type="submit">Save Photo</button>
  </form>
  <div id="message" class="msg"></div>

  <script>
    document.getElementById('uploadForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const msg = document.getElementById('message');
      msg.className = 'msg';
      msg.style.display = 'none';

      try {
        const res = await fetch('/api/images/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image_url: form.image_url.value,
            vehicle_id: form.vehicle_id.value,
            agency_code: form.agency_code.value,
            attribution: form.attribution.value,
            description: form.description.value
          })
        });
        const data = await res.json();
        if (res.ok) {
          msg.className = 'msg success';
          msg.innerHTML = 'Saved! Vehicle: <strong>' + data.vehicle_id + '</strong> | Photo: <a href="' + data.image_url + '" target="_blank">view</a>';
          if (data.attribution) msg.innerHTML += '<br>Attribution: ' + data.attribution;
          msg.style.display = 'block';
          form.reset();
        } else {
          msg.className = 'msg error';
          msg.textContent = 'Error: ' + (data.error || JSON.stringify(data));
          msg.style.display = 'block';
        }
      } catch (err) {
        msg.className = 'msg error';
        msg.textContent = 'Network error: ' + err.message;
        msg.style.display = 'block';
      }
    });
  </script>
</body>
</html>`)
}
