# Air Quality App for AugmentOS

[![AugmentOS Compatible](https://img.shields.io/badge/AugmentOS-1.2%2B-blue)](https://docs.augmentos.org)

## Features

- Real-time air quality data from [WAQI API](https://waqi.info/)
- Voice command support ("What's the air like?", "Air quality", etc.)
- Location-based results with fallback to Murcia, Spain
- Visual and audio feedback (requires compatible AugmentOS hardware)
- Production deployments on Render, Railway, and Fly may misattribute the platform's CDN as the user's geolocation. Use ngrok for a Dev-safe version.

## Installation

```bash
git clone https://github.com//paulgailey/air-quality-app.git
cd air-quality-app
bun install
