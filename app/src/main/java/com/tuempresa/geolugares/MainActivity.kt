// Paquete principal de la aplicación
package com.tuempresa.geolugares

// ==========================
// IMPORTACIÓN DE LIBRERÍAS
// ==========================
import android.Manifest
import android.content.pm.PackageManager
import android.location.Location
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.android.gms.location.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray

// ==========================
// ACTIVIDAD PRINCIPAL
// ==========================
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Configuramos Jetpack Compose como interfaz
        setContent {
            GeoShareApp() // Llamada a la función composable principal
        }
    }
}

// ==========================
// FUNCIÓN PRINCIPAL COMPOSABLE
// ==========================
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GeoShareApp() {
    val context = LocalContext.current

    // Cliente de ubicación de Google Play Services
    val fusedLocationClient = LocationServices.getFusedLocationProviderClient(context)

    // Variables de estado de la app
    var location by remember { mutableStateOf<LatLng?>(null) } // Última ubicación
    val pathPoints = remember { mutableStateListOf<LatLng>() } // Historial de ubicaciones
    var isTracking by remember { mutableStateOf(false) }        // Seguimiento activado/desactivado
    var lastAddedLocation by remember { mutableStateOf<Location?>(null) } // Última ubicación agregada
    var searchQuery by remember { mutableStateOf("") }          // Texto de búsqueda de lugares
    var routeDestination by remember { mutableStateOf<LatLng?>(null) } // Destino de la ruta
    // Identificador único del dispositivo
    val deviceId = remember { Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) }

    // ==========================
    // LANZADOR DE PERMISO
    // ==========================
    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            // Si el usuario concede el permiso, comenzamos a recibir actualizaciones de ubicación
            startLocationUpdates(fusedLocationClient) { loc ->
                location = LatLng(loc.latitude, loc.longitude) // Guardamos última ubicación
                if (isTracking) {
                    // Si hay seguimiento activo y la distancia desde la última ubicación > 1m
                    if (lastAddedLocation == null || loc.distanceTo(lastAddedLocation!!) > 1) {
                        pathPoints.add(location!!) // Agregamos al historial
                        compartirUbicacionAWS(loc.latitude, loc.longitude, deviceId) // Enviamos al servidor
                        lastAddedLocation = loc // Actualizamos última ubicación agregada
                    }
                }
            }
        }
    }

    // ==========================
    // PEDIR PERMISOS AUTOMÁTICAMENTE
    // ==========================
    LaunchedEffect(Unit) {
        when {
            // Si el permiso ya está concedido
            ContextCompat.checkSelfPermission(
                context, Manifest.permission.ACCESS_FINE_LOCATION
            ) == PackageManager.PERMISSION_GRANTED -> {
                startLocationUpdates(fusedLocationClient) { loc ->
                    location = LatLng(loc.latitude, loc.longitude)
                    if (isTracking) {
                        if (lastAddedLocation == null || loc.distanceTo(lastAddedLocation!!) > 1) {
                            pathPoints.add(location!!)
                            compartirUbicacionAWS(loc.latitude, loc.longitude, deviceId)
                            lastAddedLocation = loc
                        }
                    }
                }
            }
            else -> {
                // Si no hay permiso, lo solicitamos al usuario
                launcher.launch(Manifest.permission.ACCESS_FINE_LOCATION)
            }
        }
    }

    // ==========================
    // INTERFAZ DE USUARIO
    // ==========================
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("GeoShare - Mi ubicación") } // Título superior
            )
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding)) {
            if (location != null) { // Si tenemos ubicación
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(16.dp)
                ) {
                    // Campo de búsqueda de lugares
                    OutlinedTextField(
                        value = searchQuery,
                        onValueChange = { searchQuery = it },
                        label = { Text("Buscar lugar o dirección") },
                        modifier = Modifier.fillMaxWidth()
                    )
                    Spacer(modifier = Modifier.height(8.dp))

                    // Botón de búsqueda
                    Button(
                        onClick = {
                            if (searchQuery.isNotEmpty()) {
                                buscarLugar(searchQuery) { result ->
                                    // Guardamos destino de la ruta
                                    routeDestination = result?.let { LatLng(it.latitude, it.longitude) }
                                }
                            }
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Buscar")
                    }

                    // WebView para mostrar el mapa con Leaflet
                    AndroidView(
                        factory = { ctx ->
                            WebView(ctx).apply {
                                webViewClient = WebViewClient()
                                settings.javaScriptEnabled = true
                                loadUrl("http://18.222.185.150/") // Página del servidor con Leaflet
                            }
                        },
                        modifier = Modifier.weight(1f)
                    )

                    Spacer(modifier = Modifier.height(16.dp))

                    // Botón para iniciar/detener seguimiento
                    Button(
                        onClick = {
                            isTracking = !isTracking
                            if (isTracking && location != null) {
                                pathPoints.clear() // Limpiamos historial
                                val currentLoc = Location("").apply {
                                    latitude = location!!.latitude
                                    longitude = location!!.longitude
                                }
                                pathPoints.add(location!!) // Agregamos ubicación inicial
                                compartirUbicacionAWS(location!!.latitude, location!!.longitude, deviceId)
                                lastAddedLocation = currentLoc
                            } else {
                                lastAddedLocation = null // Reiniciamos última ubicación
                            }
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(if (isTracking) "Detener seguimiento" else "Iniciar seguimiento")
                    }

                    // Botón para calcular ruta hacia el destino
                    if (routeDestination != null) {
                        Button(
                            onClick = {
                                calcularRuta(location!!, routeDestination!!) { route ->
                                    // Enviamos la ruta al servidor para mostrarla en el mapa
                                    CoroutineScope(Dispatchers.IO).launch {
                                        enviarRutaAWS(route)
                                    }
                                }
                            },
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text("Calcular ruta")
                        }
                    }

                    // Indicador de seguimiento activo
                    if (isTracking) {
                        Text(
                            "Seguimiento activo",
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(top = 8.dp)
                        )
                    }
                }
            } else {
                // Mensaje mientras obtenemos ubicación
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(16.dp)
                ) {
                    Text("Obteniendo ubicación...")
                }
            }
        }
    }
}

// ==========================
// CLASE AUXILIAR LatLng
// ==========================
data class LatLng(val latitude: Double, val longitude: Double)

// ==========================
// FUNCIONES DE UBICACIÓN
// ==========================
fun startLocationUpdates(
    fusedLocationClient: FusedLocationProviderClient,
    callback: (Location) -> Unit
) {
    // Configuración de actualización de ubicación
    val locationRequest = LocationRequest.create().apply {
        interval = 3000 // Cada 3 segundos
        fastestInterval = 1000 // Como mínimo cada 1 segundo
        priority = LocationRequest.PRIORITY_HIGH_ACCURACY
    }

    val locationCallback = object : LocationCallback() {
        override fun onLocationResult(locationResult: LocationResult) {
            locationResult.lastLocation?.let { location ->
                callback(location) // Retornamos la ubicación al Composable
            }
        }
    }

    try {
        fusedLocationClient.requestLocationUpdates(
            locationRequest,
            locationCallback,
            null
        )
    } catch (e: SecurityException) {
        e.printStackTrace() // Si no hay permisos, capturamos excepción
    }
}

// ==========================
// FUNCIONES PARA COMUNICACIÓN CON EL SERVIDOR
// ==========================

// Envía la ubicación al servidor Node.js
fun compartirUbicacionAWS(lat: Double, lng: Double, deviceId: String) {
    val client = OkHttpClient()
    val url = "http://18.222.185.150/ubicacion"

    val json = JSONObject()
    json.put("lat", lat)
    json.put("lng", lng)
    json.put("deviceId", deviceId)

    val body = json.toString().toRequestBody("application/json".toMediaType())

    CoroutineScope(Dispatchers.IO).launch {
        try {
            client.newCall(
                Request.Builder()
                    .url(url)
                    .post(body)
                    .build()
            ).execute().use { response ->
                println("Respuesta AWS: ${response.code}")
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}

// Buscar un lugar usando Nominatim de OpenStreetMap
fun buscarLugar(query: String, callback: (LatLng?) -> Unit) {
    val client = OkHttpClient()
    val url = "https://nominatim.openstreetmap.org/search?q=$query&format=json&limit=1"

    CoroutineScope(Dispatchers.IO).launch {
        try {
            val request = Request.Builder()
                .url(url)
                .header("User-Agent", "GeoShareApp/1.0")
                .build()
            client.newCall(request).execute().use { response ->
                val jsonString = response.body?.string() ?: "[]"
                val results = JSONArray(jsonString)
                if (results.length() > 0) {
                    val result = results.getJSONObject(0)
                    val lat = result.getDouble("lat")
                    val lon = result.getDouble("lon")
                    callback(LatLng(lat, lon))
                } else {
                    callback(null)
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
            callback(null)
        }
    }
}

// Calcular ruta entre dos puntos usando OSRM
fun calcularRuta(start: LatLng, end: LatLng, callback: (List<LatLng>) -> Unit) {
    val client = OkHttpClient()
    val url = "http://router.project-osrm.org/route/v1/driving/${start.longitude},${start.latitude};${end.longitude},${end.latitude}?geometries=geojson"

    CoroutineScope(Dispatchers.IO).launch {
        try {
            val request = Request.Builder().url(url).build()
            client.newCall(request).execute().use { response ->
                val json = JSONObject(response.body?.string() ?: "{}")
                val routes = json.getJSONArray("routes")
                if (routes.length() > 0) {
                    val route = routes.getJSONObject(0)
                    val geometry = route.getJSONObject("geometry").getJSONArray("coordinates")
                    val routePoints = mutableListOf<LatLng>()
                    for (i in 0 until geometry.length()) {
                        val coord = geometry.getJSONArray(i)
                        routePoints.add(LatLng(coord.getDouble(1), coord.getDouble(0)))
                    }
                    callback(routePoints)
                } else {
                    callback(emptyList())
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
            callback(emptyList())
        }
    }
}

// Envía la ruta al servidor para mostrar en el mapa
fun enviarRutaAWS(route: List<LatLng>) {
    val client = OkHttpClient()
    val url = "http://18.222.185.150/ruta"

    val jsonArray = JSONArray()
    route.forEach { point ->
        val json = JSONObject().apply {
            put("lat", point.latitude)
            put("lng", point.longitude)
        }
        jsonArray.put(json)
    }

    val body = jsonArray.toString().toRequestBody("application/json".toMediaType())

    CoroutineScope(Dispatchers.IO).launch {
        try {
            client.newCall(
                Request.Builder()
                    .url(url)
                    .post(body)
                    .build()
            ).execute().use { response ->
                println("Ruta enviada al servidor: ${response.code}")
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}
