// Import necessary modules
import { AQI_LEVELS } from './types/types'; // Ensure the path to types.ts is correct
import { getAirQuality } from './services/airQualityService'; // Ensure this points to the correct service

// Define the AQILevel type if needed
type AQILevel = {
  max: number;
  label: string;
  emoji: string;
  advice: string;
};

// Initialize tpaSession (ensure this is available in your environment)
declare const tpaSession: any; // Ensure tpaSession is correctly imported or available in the environment

// This function gets the air quality based on the user's location
async function getAirQualityBasedOnLocation() {
  // Retrieve location using tpaSession (ensure this works with your setup)
  tpaSession.events.onLocation(async (coords: { lat: number; lon: number }) => {
    console.log(`📍 Using coordinates: ${coords.lat}, ${coords.lon}`);

    // Get the nearest AQI station based on the user's coordinates
    const station = await getAirQuality(coords.lat, coords.lon);

    // Find the appropriate AQI level based on the station's AQI value
    const quality = AQI_LEVELS.find((l: AQILevel) => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];

    // Display the air quality information
    await tpaSession.layouts.showTextWall(
      `📍 ${station.station.name}\n\n` +
      `Air Quality: ${quality.label} ${quality.emoji}\n` +
      `AQI: ${station.aqi}\n\n` +
      `${quality.advice}`,
      { view: 'MAIN', durationMs: 10000 }
    );
  });
}

// Execute the function to get the air quality based on the user's location
getAirQualityBasedOnLocation().catch((error) => {
  console.error('Error getting air quality data:', error);
});
