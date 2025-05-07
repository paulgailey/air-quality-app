import axios from 'axios';
import { AQIStation } from '../types/types.js';

interface AQIAPIResponse {
  status: 'ok' | 'error';
  data: {
    aqi: number;
    city?: {
      name: string;
      geo: [number, number];
    };
    message?: string; // Ensure this property exists in the interface
  };
}

export async function getNearestAQIStation(
  lat: number,
  lon: number,
  retries = 2
): Promise<AQIStation> {
  const AQI_TOKEN = process.env.AQI_TOKEN;
  if (!AQI_TOKEN) {
    throw new Error('AQI_TOKEN environment variable is not set');
  }

  try {
    const response = await axios.get<AQIAPIResponse>(
      `https://api.waqi.info/feed/geo:${lat};${lon}/`,
      {
        params: { token: AQI_TOKEN },
        timeout: 5000, // 5 second timeout
        validateStatus: (status) => status < 500 // Don't throw on 4xx errors
      }
    );

    if (!response.data || response.data.status !== 'ok') {
      throw new Error(response.data.message || 'Invalid AQI API response');
    }

    if (typeof response.data.data.aqi !== 'number') {
      throw new Error('Invalid AQI value received');
    }

    return {
      aqi: response.data.data.aqi,
      station: {
        name: response.data.data.city?.name || `Station at ${lat.toFixed(2)},${lon.toFixed(2)}`,
        geo: response.data.data.city?.geo || [lat, lon]
      }
    };
  } catch (error) {
    console.error(`AQI API Error (${retries} retries left):`, error);

    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
      return getNearestAQIStation(lat, lon, retries - 1);
    }

    throw new Error(
      axios.isAxiosError(error)
        ? `Network error: ${error.message}`
        : 'Failed to fetch air quality data'
    );
  }
}