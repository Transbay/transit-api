package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func TestResizeImageDownscales(t *testing.T) {
	// Twice the cap in each direction, so it is downscaled whatever `scale` is set to.
	w, h := 2*maxImageWidth, 2*maxImageHeight
	src := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			src.Set(x, y, color.RGBA{uint8(x % 256), 40, uint8(y % 256), 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, src); err != nil {
		t.Fatalf("encode: %v", err)
	}

	out, ct, err := resizeImage(buf.Bytes(), "image/png")
	if err != nil {
		t.Fatalf("resizeImage: %v", err)
	}
	scaled, _, err := image.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("decode resized: %v", err)
	}
	b := scaled.Bounds()
	if b.Dx() > maxImageWidth || b.Dy() > maxImageHeight {
		t.Fatalf("resized image too big: %dx%d", b.Dx(), b.Dy())
	}
	if ct != "image/jpeg" {
		t.Fatalf("expected jpeg content type, got %s", ct)
	}
}

func TestResizeImageLeavesSmallImagesAlone(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 64, 48))
	var buf bytes.Buffer
	if err := png.Encode(&buf, src); err != nil {
		t.Fatalf("encode: %v", err)
	}

	out, ct, err := resizeImage(buf.Bytes(), "image/png")
	if err != nil {
		t.Fatalf("resizeImage: %v", err)
	}
	if ct != "image/png" {
		t.Fatalf("expected input content type preserved, got %s", ct)
	}
	scaled, _, err := image.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("decode resized: %v", err)
	}
	b := scaled.Bounds()
	if b.Dx() != 64 || b.Dy() != 48 {
		t.Fatalf("small image was resized: %dx%d", b.Dx(), b.Dy())
	}
}