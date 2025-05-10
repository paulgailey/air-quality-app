// src/geoLocationMiddleware.ts

import axios from "axios";
import { Request, Response, NextFunction } from "express";

interface Location {
  city?: string;
  region?: string;
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

    const response = await axios.get(`http://ip-api.com/json/${ip}`);
    if (response.data.status === "success") {
      const { city, regionName: region, country, lat, lon } = response.data;
      req.location = { city, region, country, lat, lon };
    }
  } catch (error) {
    console.error("Geolocation middleware error:", error);
  }

  next();
};

export default geoLocationMiddleware;
