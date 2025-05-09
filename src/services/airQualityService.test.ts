import { getNearestAQIStation } from './airQualityService';

async function testAQIService() {
  // Test with London coordinates
  const lat = 51.5074;
  const lon = -0.1278;
  
  console.log(`Testing AQI service for coordinates: ${lat}, ${lon}`);
  
  try {
    const result = await getNearestAQIStation(lat, lon);
    console.log('✅ Test succeeded! Received data:');
    console.log(`Station: ${result.station.name}`);
    console.log(`AQI: ${result.aqi}`);
  } catch (error) {
    console.error('❌ Test failed:');
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error('Unknown error occurred');
    }
    process.exit(1); // Exit with error code
  }
}

// Run the test
testAQIService();