# Air Quality App for AugmentOS

[![AugmentOS Compatible](https://img.shields.io/badge/AugmentOS-1.2%2B-blue)](https://docs.augmentos.org)

## Features

- Real-time air quality data from [WAQI API](https://waqi.info/)
- Voice command support ("What's the air like?", "Air quality", etc.)
- Location-based results with fallback to Murcia, Spain
- Visual and audio feedback (requires compatible AugmentOS hardware)
- This is a Dev safe version with ngrok. Production deployments fail on Render, Railway, Fly mis-attribute the platforms' CDN for the users geolocation.

## Installation

```bash
git clone https://github.com//paulgailey/air-quality-app.git
cd air-quality-app
bun install
