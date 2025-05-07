// src/geoLocationMiddleware.ts
import axios from "axios";
const geoLocationMiddleware = async (req, res, next) => {
    try {
        const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0] ||
            req.socket.remoteAddress;
        if (!ip || ip === "::1") {
            return next();
        }
        const response = await axios.get(`http://ip-api.com/json/${ip}`);
        if (response.data.status === "success") {
            const { city, regionName: region, country, lat, lon } = response.data;
            req.location = { city, region, country, lat, lon };
        }
    }
    catch (error) {
        console.error("Geolocation middleware error:", error);
    }
    next();
};
export default geoLocationMiddleware;
