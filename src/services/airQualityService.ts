import axios, { AxiosError, isAxiosError } from 'axios';
import { AQIStation } from '../types/types.js';

interface AQIAPIResponse {
  status: 'ok' | 'error';
  data: {
    aqi: number;
    city?: {
      name: string;
      geo: [number, number];
    };
  };
  message?: string;
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
        timeout: 5000,
        validateStatus: (status: number) => status < 500
      }
    );

    if (!response.data || response.data.status !== 'ok') {
      throw new Error(response.data?.message || 'Invalid AQI API response');
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
  } catch (error: unknown) {
    console.error(`AQI API Error (${retries} retries left):`, error instanceof Error ? error.message : error);

    if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return getNearestAQIStation(lat, lon, retries - 1);
    }

    if (isAxiosError(error)) {  // Use the imported function
        throw new Error(`Network error: ${error.message}`);
    }
    if (error instanceof Error) {
        throw error;
    }
    throw new Error('Unknown error occurred while fetching air quality data');
}
}