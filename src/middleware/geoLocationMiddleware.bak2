// src/geoLocationMiddleware.ts

import axios from "axios";
import { Request, Response, NextFunction } from "express";

// Add proper type for the API response
interface GeoLocationResponse {
  status: string;
  city?: string;
  regionName?: string;
  country?: string;
  lat?: number;
  lon?: number;
}

declare module "express-serve-static-core" {
  interface Request {
    location?: Location;
  }
}

const geoLocationMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const ip =
      req.headers["x-forwarded-for"]?.toString().split(",")[0] ||
      req.socket.remoteAddress;

    if (!ip || ip === "::1") {
      return next();
    }

    const response = await axios.get<GeoLocationResponse>('http://ip-api.com/json/');
if (response.data.status === "success") {
  const { city, regionName: region, country, lat, lon } = response.data;
    }
  } catch (error) {
    console.error("Geolocation middleware error:", error);
  }

  next();
};

export default geoLocationMiddleware;
