import axios, { isAxiosError } from 'axios';
export async function getNearestAQIStation(lat, lon, retries = 2) {
    const AQI_TOKEN = process.env.AQI_TOKEN;
    if (!AQI_TOKEN) {
        throw new Error('AQI_TOKEN environment variable is not set');
    }
    try {
        const response = await axios.get(`https://api.waqi.info/feed/geo:${lat};${lon}/`, {
            params: { token: AQI_TOKEN },
            timeout: 5000,
            validateStatus: (status) => status < 500
        });
        if (!response.data || response.data.status !== 'ok') {
            throw new Error(response.data?.message || 'Invalid AQI API response');
        }
        const aqi = response.data.data.aqi;
        const name = response.data.data.city?.name || `Station at ${lat.toFixed(2)},${lon.toFixed(2)}`;
        const geo = response.data.data.city?.geo || [lat, lon];
        return {
            aqi,
            station: { name, geo },
            getLatestAQI: () => aqi
        };
    }
    catch (error) {
        console.error(`AQI API Error (${retries} retries left):`, error instanceof Error ? error.message : error);
        if (retries > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return getNearestAQIStation(lat, lon, retries - 1);
        }
        if (isAxiosError(error)) {
            throw new Error(`Network error: ${error.message}`);
        }
        if (error instanceof Error) {
            throw error;
        }
        throw new Error('Unknown error occurred while fetching air quality data');
    }
}
