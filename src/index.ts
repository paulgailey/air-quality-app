import { AQI_LEVELS } from './types/types';  // Import AQI levels from types.ts
import { AirQualityService } from './services/airQualityService';  // Import air quality service for fetching data

const airQualityService = new AirQualityService();

// This function gets the air quality based on the coordinates and displays it
async function getAirQualityAndDisplay(coords: { lat: number, lon: number }) {
  try {
    // Fetch the nearest AQI station data based on the coordinates
    const station = await airQualityService.getNearestAQIStation(coords.lat, coords.lon);

    // Find the appropriate air quality level based on the AQI value
    const quality = AQI_LEVELS.find(level => station.aqi <= level.max) || AQI_LEVELS[AQI_LEVELS.length - 1];

    // Show the air quality information using TeamOS's showTextWall method
    await session.layouts.showTextWall(
      `📍 ${station.station.name}\n\n` +
      `Air Quality: ${quality.label} ${quality.emoji}\n` +
      `AQI: ${station.aqi}\n\n` +
      `${quality.advice}`,
      { view: ViewType.MAIN, durationMs: 10000 }
    );

  } catch (error) {
    console.error("Error fetching air quality data:", error);
  }
}

// Set up the location listener using TeamOS's recommended method
tpaSession.events.onLocation(async (coords) => {
  console.log(`📍 Using coordinates: ${coords.lat}, ${coords.lon}`);
  
  // Call the function to fetch and display air quality
  await getAirQualityAndDisplay(coords);
});
