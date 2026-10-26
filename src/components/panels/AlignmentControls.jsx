import React, { useEffect, useRef, useState } from "react";
import Field from "../ui/Field.jsx";
import { num } from "../../utils/number.js";
import { localToGeographic } from "../../utils/geographicAlignment.js";
import { pointsOf } from "../../utils/geometry.js";

export { AlignmentEditor, BuildingAlignmentSetup };

let mapsApiPromise;

function loadGoogleMaps(key) {
  if (window.google?.maps?.places) return Promise.resolve(window.google);
  if (!mapsApiPromise) {
    mapsApiPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly`;
      script.async = true;
      script.onload = () =>
        window.google?.maps?.importLibrary
          ? resolve(window.google)
          : reject(new Error("Google Maps could not be initialized."));
      script.onerror = () => reject(new Error("Google Maps could not be loaded."));
      document.head.appendChild(script);
    }).catch((error) => {
      mapsApiPromise = null;
      throw error;
    });
  }
  return mapsApiPromise;
}

function AlignmentEditor({ alignment, onSave, onOpenSetup }) {
  const [draft, setDraft] = useState(
    () => alignment || { lat: "", lng: "", x: 0, z: 0, rotationDeg: 0 },
  );
  useEffect(
    () =>
      setDraft(alignment || { lat: "", lng: "", x: 0, z: 0, rotationDeg: 0 }),
    [alignment],
  );
  return (
    <div className="form-grid">
      {[
        ["lat", "Latitude"],
        ["lng", "Longitude"],
        ["x", "Plan anchor X (m)"],
        ["z", "Plan anchor Z (m)"],
        ["rotationDeg", "Rotation (°)"],
      ].map(([key, label]) => (
        <Field
          key={key}
          label={label}
          type="number"
          value={draft[key]}
          onChange={(value) => setDraft((current) => ({ ...current, [key]: value }))}
        />
      ))}
      <div className="row">
        <button
          className="primary"
          onClick={() => onSave(draft)}
          disabled={draft.lat === "" || draft.lng === ""}
        >
          Save alignment
        </button>
        <button type="button" onClick={onOpenSetup}>
          Set up building on map
        </button>
      </div>
    </div>
  );
}

function BuildingAlignmentSetup({ alignment, rooms, onSave, onBack }) {
  const [draft, setDraft] = useState(() =>
    alignment || {
      lat: 20.5937,
      lng: 78.9629,
      x: 0,
      z: 0,
      rotationDeg: 0,
    },
  );
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchText, setSearchText] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const mapElement = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const polygonsRef = useRef([]);
  const sessionTokenRef = useRef(null);
  const searchRequestRef = useRef(0);

  useEffect(() => {
    const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    if (!key) {
      setMapError("Add VITE_GOOGLE_MAPS_API_KEY to enable place search and map alignment.");
      return;
    }
    let mapClickListener;
    let markerDragListener;
    loadGoogleMaps(key)
      .then(async (google) => {
        if (!mapElement.current) return;
        const mapsLibrary = await google.maps.importLibrary("maps");
        const center = {
          lat: num(draft.lat, 20.5937),
          lng: num(draft.lng, 78.9629),
        };
        const map = new mapsLibrary.Map(mapElement.current, {
          center,
          zoom: 19,
          mapTypeId: "satellite",
        });
        mapRef.current = map;
        const marker = new google.maps.Marker({
          map,
          position: center,
          draggable: true,
          title: "Building anchor",
        });
        markerRef.current = marker;
        mapClickListener = map.addListener("click", (event) => {
          if (!event.latLng) return;
          const location = { lat: event.latLng.lat(), lng: event.latLng.lng() };
          marker.setPosition(location);
          setDraft((current) => ({ ...current, ...location }));
        });
        markerDragListener = marker.addListener("dragend", (event) => {
          if (event.latLng)
            setDraft((current) => ({
              ...current,
              lat: event.latLng.lat(),
              lng: event.latLng.lng(),
            }));
        });
        setReady(true);
      })
      .catch((error) => setMapError(error.message));
    return () => {
      mapClickListener?.remove();
      markerDragListener?.remove();
      polygonsRef.current.forEach((polygon) => polygon.setMap(null));
    };
  }, []);

  useEffect(() => {
    if (!ready || !showSearch || searchText.trim().length < 2) {
      setSuggestions([]);
      setSearching(false);
      return;
    }
    const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    const requestId = ++searchRequestRef.current;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      setSearchError("");
      try {
        const google = await loadGoogleMaps(key);
        const {
          AutocompleteSessionToken,
          AutocompleteSuggestion,
        } = await google.maps.importLibrary("places");
        if (!sessionTokenRef.current)
          sessionTokenRef.current = new AutocompleteSessionToken();
        const center = mapRef.current?.getCenter();
        const request = {
          input: searchText.trim(),
          sessionToken: sessionTokenRef.current,
          ...(center && {
            locationBias: {
              radius: 5000,
              center: { lat: center.lat(), lng: center.lng() },
            },
          }),
        };
        let matches;
        try {
          const response =
            await AutocompleteSuggestion.fetchAutocompleteSuggestions(request);
          matches = (response.suggestions || [])
            .filter((suggestion) => suggestion.placePrediction)
            .map((suggestion) => ({ placePrediction: suggestion.placePrediction }));
        } catch (newPlacesError) {
          sessionTokenRef.current = null;
          const service = new google.maps.places.AutocompleteService();
          const center = mapRef.current?.getCenter();
          const predictions = await new Promise((resolve, reject) => {
            service.getPlacePredictions(
              {
                input: searchText.trim(),
                ...(center && { location: center, radius: 5000 }),
              },
              (results, status) => {
                if (status === "OK") resolve(results || []);
                else if (status === "ZERO_RESULTS") resolve([]);
                else reject(new Error(`Legacy Places search failed: ${status}`));
              },
            );
          }).catch((legacyError) => {
            throw new Error(
              `${newPlacesError?.message || "Places API (New) failed."} Legacy fallback: ${legacyError.message}`,
            );
          });
          matches = predictions.map((legacyPrediction) => ({ legacyPrediction }));
        }
        if (requestId !== searchRequestRef.current) return;
        setSuggestions(matches);
        if (!matches.length) setSearchError("No matching places found.");
      } catch (error) {
        if (requestId === searchRequestRef.current) {
          setSuggestions([]);
          setSearchError(
            error?.message ||
              "Place search failed. Check that Places API (New) is enabled and the Maps key allows this site.",
          );
        }
      } finally {
        if (requestId === searchRequestRef.current) setSearching(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      if (requestId === searchRequestRef.current) searchRequestRef.current += 1;
    };
  }, [ready, showSearch, searchText]);

  useEffect(() => {
    if (!ready || !mapRef.current || !markerRef.current) return;
    const anchor = { lat: num(draft.lat), lng: num(draft.lng) };
    if (!Number.isFinite(anchor.lat) || !Number.isFinite(anchor.lng)) return;
    markerRef.current.setPosition(anchor);
    mapRef.current.panTo(anchor);
    polygonsRef.current.forEach((polygon) => polygon.setMap(null));
    polygonsRef.current = rooms.flatMap((room) => {
      const path = pointsOf(room).flatMap((point) => {
        const location = localToGeographic(point, { ...draft, unit: "m" });
        return location ? [{ lat: location.lat, lng: location.lng }] : [];
      });
      if (path.length < 3) return [];
      return [
        new window.google.maps.Polygon({
          map: mapRef.current,
          paths: path,
          clickable: false,
          fillColor: "#23b99a",
          fillOpacity: 0.22,
          strokeColor: "#087c68",
          strokeOpacity: 0.95,
          strokeWeight: 2,
        }),
      ];
    });
  }, [ready, draft, rooms]);

  const update = (key, value) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const selectPlace = async (suggestion) => {
    try {
      let location;
      let viewport;
      if (suggestion.placePrediction) {
        const place = suggestion.placePrediction.toPlace();
        await place.fetchFields({ fields: ["location", "viewport"] });
        if (place.location)
          location = { lat: place.location.lat(), lng: place.location.lng() };
        viewport = place.viewport;
      } else {
        const service = new window.google.maps.places.PlacesService(mapRef.current);
        const place = await new Promise((resolve, reject) => {
          service.getDetails(
            {
              placeId: suggestion.legacyPrediction.place_id,
              fields: ["geometry", "name", "formatted_address"],
            },
            (result, status) => {
              if (status === "OK" && result?.geometry?.location)
                resolve(result);
              else reject(new Error(`Legacy Place Details failed: ${status}`));
            },
          );
        });
        const point = place.geometry.location;
        location = { lat: point.lat(), lng: point.lng() };
        viewport = place.geometry.viewport;
      }
      if (!location) {
        setSearchError("That place does not include a map location.");
        return;
      }
      setDraft((current) => ({ ...current, ...location }));
      if (viewport) mapRef.current?.fitBounds(viewport);
      else {
        mapRef.current?.setCenter(location);
        mapRef.current?.setZoom(19);
      }
      sessionTokenRef.current = null;
      setSuggestions([]);
      setSearchText("");
      setSearchError("");
      setShowSearch(false);
    } catch (error) {
      setSearchError(error.message || "Could not load that place. Try another search.");
    }
  };

  return (
    <div className="alignment-setup">
      <div className="section-title alignment-setup-heading">
        <div className="alignment-setup-actions">
          <button type="button" onClick={onBack}>← Back</button>
          <button type="button" onClick={onBack}>Cancel</button>
          <button className="primary" type="button" onClick={() => onSave(draft)}>
            Save building alignment
          </button>
``        </div>
      </div>
      <div className="geo-preview alignment-setup-map">
        <div className="google-map-canvas" ref={mapElement} />
        {ready && (
          <button
            className="map-search-toggle"
            type="button"
            aria-label={showSearch ? "Close place search" : "Search places"}
            title={showSearch ? "Close search" : "Search places"}
            onClick={() => {
              setSearchError("");
              setSearchText("");
              setShowSearch((open) => {
                if (open) sessionTokenRef.current = null;
                return !open;
              });
            }}
          >
            {showSearch ? (
              <span aria-hidden="true">×</span>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="10.8" cy="10.8" r="6.3" />
                <path d="m15.5 15.5 5 5" />
              </svg>
            )}
          </button>
        )}
        {showSearch && (
          <div className="map-search-panel">
            <input
              autoFocus
              type="search"
              value={searchText}
              placeholder="Search a place or address"
              aria-label="Search a place or address"
              onChange={(event) => setSearchText(event.target.value)}
            />
            {searching && <small role="status">Searching places…</small>}
            {searchError && <small role="status">{searchError}</small>}
            {!!suggestions.length && (
              <div className="map-search-suggestions" role="listbox">
                {suggestions.map((suggestion, index) => (
                  <button
                    key={`${suggestion.placePrediction?.placeId || suggestion.legacyPrediction?.place_id || "place"}-${index}`}
                    type="button"
                    role="option"
                    onClick={() => selectPlace(suggestion)}
                  >
                    {suggestion.placePrediction
                      ? suggestion.placePrediction.text.toString()
                      : suggestion.legacyPrediction.description}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {!ready && !mapError && <div className="map-loading">Loading map…</div>}
        {mapError && <div className="map-loading map-error">{mapError}</div>}
      </div>
      <div className="alignment-setup-controls">
        {[
          ["lat", "Latitude"],
          ["lng", "Longitude"],
          ["x", "Plan anchor X (m)"],
          ["z", "Plan anchor Z (m)"],
          ["rotationDeg", "Rotation (°)"],
        ].map(([key, label]) => (
          <Field
            key={key}
            label={label}
            type="number"
            value={draft[key]}
            onChange={(value) => update(key, value)}
          />
        ))}
      </div>
      <div className="alignment-map-legend">
        <span className="alignment-legend-building" /> Plan rooms
        <span className="alignment-legend-pin">●</span> Building anchor
        <span>Click map or drag pin to adjust location.</span>
      </div>
      {!rooms.length && (
        <p className="alignment-setup-help">
          This floor has no room outlines yet. Add or import rooms in the editor to preview the building shape here.
        </p>
      )}
      
    </div>
  );
}
