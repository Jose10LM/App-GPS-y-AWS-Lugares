// ==========================
// IMPORTACIÓN DE MÓDULOS
// ==========================
const express = require("express");           // Framework web para Node.js
const bodyParser = require("body-parser");    // Para parsear el cuerpo de las solicitudes HTTP
const http = require("http");                 // Servidor HTTP nativo de Node.js
const { Server } = require("socket.io");      // Comunicación en tiempo real con WebSockets
const axios = require("axios");               // Cliente HTTP para hacer peticiones externas

// ==========================
// CONFIGURACIÓN DEL SERVIDOR
// ==========================
const app = express();                        // Inicializamos la app de Express
const server = http.createServer(app);        // Creamos el servidor HTTP
const io = new Server(server);                // Inicializamos Socket.IO con el servidor HTTP

// Middleware para parsear JSON en las solicitudes
app.use(bodyParser.json());

// ==========================
// VARIABLES GLOBALES
// ==========================
let pathPoints = [];          // Lista de puntos de ubicación recibidos
let currentRoute = [];        // Lista de puntos de la ruta actual
let lastKnownLocation = null; // Última ubicación conocida

// ==========================
// RUTA POST /ubicacion
// Recibe la ubicación de un dispositivo y la guarda
// ==========================
app.post("/ubicacion", (req, res) => {
    const { lat, lng, deviceId } = req.body; // Extraemos latitud, longitud y deviceId del cuerpo
    if (lat && lng) {                         // Validamos que existan lat y lng
        const newPoint = { 
            lat, 
            lng, 
            fecha: new Date().toISOString(), // Guardamos la fecha actual en ISO
            deviceId 
        };
        pathPoints.push(newPoint);            // Agregamos el punto al historial
        lastKnownLocation = { lat, lng };     // Actualizamos última ubicación conocida
        console.log("Nueva ubicación recibida:", newPoint);

        // Enviamos la ubicación a todos los clientes conectados en tiempo real
        io.emit("newLocation", newPoint);

        // Respondemos al cliente que la ubicación fue recibida
        res.json({ mensaje: "Ubicación recibida correctamente" });
    } else {
        // Si faltan parámetros, devolvemos error
        res.status(400).json({ error: "Faltan parámetros lat y lng" });
    }
});

// ==========================
// RUTA POST /ruta
// Recibe una ruta completa y la envía a los clientes
// ==========================
app.post("/ruta", (req, res) => {
    // Guardamos la ruta recibida y formateamos solo lat/lng
    currentRoute = req.body.map(point => ({ lat: point.lat, lng: point.lng }));

    // Enviamos la ruta a todos los clientes conectados
    io.emit("newRoute", currentRoute);

    // Respondemos al cliente
    res.json({ mensaje: "Ruta recibida correctamente" });
});

// ==========================
// RUTA GET /buscar
// Permite buscar lugares usando Nominatim (OpenStreetMap)
// ==========================
app.get("/buscar", async (req, res) => {
    const query = req.query.q;           // Parámetro de búsqueda
    const { lat, lng } = req.query;      // Coordenadas opcionales para acotar la búsqueda

    if (!query) {
        return res.status(400).json({ error: "Falta el parámetro de búsqueda" });
    }

    try {
        // URL base de Nominatim
        let url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5`;

        // Si se pasan lat/lng, creamos un viewbox para acotar resultados
        if (lat && lng) {
            const viewbox = `${parseFloat(lng) - 0.05},${parseFloat(lat) + 0.05},${parseFloat(lng) + 0.05},${parseFloat(lat) - 0.05}`;
            url += `&viewbox=${viewbox}&bounded=1`;
        }

        // Petición HTTP a Nominatim
        const response = await axios.get(url, {
            headers: { "User-Agent": "GeoShareApp/1.0" } // Nominatim requiere User-Agent
        });

        // Devolvemos los resultados al cliente
        res.json(response.data);
    } catch (error) {
        console.error("Error en búsqueda:", error);
        res.status(500).json({ error: "Error al buscar lugar" });
    }
});

// ==========================
// RUTA GET /ruta
// Calcula la ruta entre dos puntos usando OSRM
// ==========================
app.get("/ruta", async (req, res) => {
    const { startLat, startLng, endLat, endLng } = req.query;

    // Validación de parámetros
    if (!startLat || !startLng || !endLat || !endLng) {
        return res.status(400).json({ error: "Faltan parámetros de coordenadas" });
    }

    try {
        // Petición a OSRM para calcular ruta en coche
        const response = await axios.get(
            `http://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?geometries=geojson`
        );

        // Extraemos la ruta en lat/lng
        const route = response.data.routes[0].geometry.coordinates.map(coord => ({
            lat: coord[1],
            lng: coord[0]
        }));

        // Guardamos la ruta actual y la emitimos a clientes
        currentRoute = route;
        io.emit("newRoute", currentRoute);

        // Respondemos al cliente
        res.json({ mensaje: "Ruta calculada correctamente", route });
    } catch (error) {
        console.error("Error al calcular ruta:", error);
        res.status(500).json({ error: "Error al calcular ruta" });
    }
});

// ==========================
// RUTA GET /
// Página HTML que muestra el mapa y la interfaz
// ==========================
app.get("/", (req, res) => {
    res.send(`
        <!-- HTML para el mapa y la interfaz -->
        <html>
            <head>
                <title>Recorrido en tiempo real</title>
                <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
                <style>
                    #map { height: 600px; width: 100%; }
                    #info { margin-bottom: 10px; }
                    #searchContainer { position: relative; }
                    #searchInput { width: 200px; margin-right: 10px; }
                    #sugerencias { border: 1px solid #ccc; position: absolute; background: white; z-index: 1000; width: 200px; max-height: 200px; overflow-y: auto; }
                </style>
            </head>
            <body>
                <!-- Información del recorrido -->
                <div id="info">
                    <h2>Recorrido actual</h2>
                    <p>Puntos: <span id="pointsCount">0</span></p>
                    <p>Última ubicación: <span id="lastLocation"></span></p>
                    <p>Fecha: <span id="lastDate"></span></p>
                    <div id="searchContainer">
                        <input type="text" id="searchInput" placeholder="Buscar lugar o dirección" oninput="mostrarSugerencias()">
                        <div id="sugerencias"></div>
                        <button onclick="calcularRuta()" id="routeButton" disabled>Calcular Ruta</button>
                    </div>
                </div>

                <!-- Contenedor del mapa -->
                <div id="map"></div>

                <!-- Scripts -->
                <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
                <script src="/socket.io/socket.io.js"></script>
                <script>
                    // Variables del mapa y rutas
                    let map;
                    let markers = [];
                    let routeLayer = null;
                    let lastMarker = null;
                    let lastSearchResult = null;
                    let searchMarker = null;
                    let sugerenciasData = [];

                    // Inicializa el mapa con los puntos iniciales
                    function initMap(initialPoints = []) {
                        map = L.map('map').setView(
                            initialPoints.length ? [initialPoints[initialPoints.length - 1].lat, initialPoints[initialPoints.length - 1].lng] : [-13.5223828, -71.9529381],
                            15
                        );

                        // Capa de mapa de OpenStreetMap
                        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                            attribution: '&copy; OpenStreetMap contributors'
                        }).addTo(map);

                        // Dibujamos los puntos iniciales
                        initialPoints.forEach((pos) => {
                            const circle = L.circle([pos.lat, pos.lng], {
                                color: 'blue',
                                fillColor: 'blue',
                                fillOpacity: 1,
                                radius: 2
                            }).addTo(map);
                            markers.push(circle);
                        });

                        // Marcador de la última posición
                        if (initialPoints.length) {
                            lastMarker = L.marker([initialPoints[initialPoints.length - 1].lat, initialPoints[initialPoints.length - 1].lng], {
                                title: "Última posición"
                            }).addTo(map);
                            updateInfo(initialPoints[initialPoints.length - 1]);
                        }
                    }

                    // Actualiza la información de recorrido en la interfaz
                    function updateInfo(point) {
                        document.getElementById("pointsCount").innerText = markers.length;
                        document.getElementById("lastLocation").innerText = "Lat " + point.lat + ", Lng " + point.lng;
                        document.getElementById("lastDate").innerText = point.fecha;
                    }

                    // Muestra sugerencias al buscar un lugar
                    function mostrarSugerencias() {
                        const query = document.getElementById("searchInput").value;
                        const sugerenciasDiv = document.getElementById("sugerencias");
                        sugerenciasDiv.innerHTML = "";
                        if (!query) return;

                        const lat = lastMarker ? lastMarker.getLatLng().lat : -13.5223828;
                        const lng = lastMarker ? lastMarker.getLatLng().lng : -71.9529381;

                        fetch(\`/buscar?q=\${encodeURIComponent(query)}&lat=\${lat}&lng=\${lng}\`)
                            .then(res => res.json())
                            .then(data => {
                                sugerenciasData = data;
                                data.forEach((item, index) => {
                                    const div = document.createElement("div");
                                    div.innerText = item.display_name;
                                    div.style.padding = "4px";
                                    div.style.cursor = "pointer";
                                    div.onmouseover = () => div.style.background = "#eee";
                                    div.onmouseout = () => div.style.background = "white";
                                    div.onclick = () => seleccionarSugerencia(index);
                                    sugerenciasDiv.appendChild(div);
                                });
                            })
                            .catch(error => console.error("Error en búsqueda:", error));
                    }

                    // Selecciona un lugar de las sugerencias y lo marca en el mapa
                    function seleccionarSugerencia(index) {
                        const item = sugerenciasData[index];
                        lastSearchResult = { lat: parseFloat(item.lat), lon: parseFloat(item.lon) };
                        if (searchMarker) map.removeLayer(searchMarker);

                        searchMarker = L.marker([lastSearchResult.lat, lastSearchResult.lon])
                            .addTo(map)
                            .bindPopup(item.display_name)
                            .openPopup();

                        map.setView([lastSearchResult.lat, lastSearchResult.lon], 15);
                        document.getElementById("routeButton").disabled = false;
                        document.getElementById("sugerencias").innerHTML = "";
                        document.getElementById("searchInput").value = item.display_name;
                    }

                    // Calcula la ruta desde la ubicación actual hasta el destino
                    function calcularRuta() {
                        if (!lastSearchResult || !lastMarker) {
                            alert("No hay ubicación actual o destino seleccionado");
                            return;
                        }
                        const start = lastMarker.getLatLng();
                        const end = lastSearchResult;
                        fetch(\`/ruta?startLat=\${start.lat}&startLng=\${start.lng}&endLat=\${end.lat}&endLng=\${end.lon}\`)
                            .then(response => response.json())
                            .then(data => {
                                if (data.route) {
                                    if (routeLayer) {
                                        map.removeLayer(routeLayer);
                                    }
                                    routeLayer = L.polyline(data.route.map(p => [p.lat, p.lng]), {
                                        color: 'red',
                                        weight: 4
                                    }).addTo(map);
                                    map.fitBounds(routeLayer.getBounds());
                                }
                            })
                            .catch(error => {
                                console.error("Error al calcular ruta:", error);
                                alert("Error al calcular ruta");
                            });
                    }

                    // ==========================
                    // SOCKET.IO
                    // ==========================
                    const socket = io();

                    socket.on("connect", () => {
                        console.log("Conectado al servidor en tiempo real");
                        socket.emit("getInitialPoints"); // Solicitar puntos iniciales
                    });

                    socket.on("initialPoints", (initialPoints) => {
                        initMap(initialPoints); // Inicializar mapa con puntos existentes
                    });

                    socket.on("newLocation", (newPoint) => {
                        // Agregar punto nuevo al mapa
                        const circle = L.circle([newPoint.lat, newPoint.lng], {
                            color: 'blue',
                            fillColor: 'blue',
                            fillOpacity: 1,
                            radius: 2
                        }).addTo(map);
                        markers.push(circle);

                        // Actualizar marcador de última posición
                        if (!lastMarker) {
                            lastMarker = L.marker([newPoint.lat, newPoint.lng], {
                                title: "Última posición"
                            }).addTo(map);
                        } else {
                            lastMarker.setLatLng([newPoint.lat, newPoint.lng]);
                        }

                        map.setView([newPoint.lat, newPoint.lng], 15);
                        updateInfo(newPoint);
                    });

                    socket.on("newRoute", (routePoints) => {
                        if (routeLayer) map.removeLayer(routeLayer);
                        routeLayer = L.polyline(routePoints.map(p => [p.lat, p.lng]), {
                            color: 'red',
                            weight: 4
                        }).addTo(map);
                        map.fitBounds(routeLayer.getBounds());
                    });

                    window.onload = () => {
                        if (!map) initMap();
                    };
                </script>
            </body>
        </html>
    `);
});

// ==========================
// SOCKET.IO CONNECTION
// ==========================
io.on("connection", (socket) => {
    console.log("Nuevo cliente conectado");

    // Enviar datos iniciales al cliente
    socket.emit("initialPoints", pathPoints);
    socket.emit("newRoute", currentRoute);

    socket.on("disconnect", () => {
        console.log("Cliente desconectado");
    });
});

// ==========================
// INICIO DEL SERVIDOR
// ==========================
server.listen(80, "0.0.0.0", () => {
    console.log("Servidor corriendo en http://0.0.0.0:80 con Socket.IO");
});
