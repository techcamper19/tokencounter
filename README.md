# Token Spend

A lightweight, zero-dependency web app for estimating LLM API token spend using live model pricing from [OpenRouter](https://openrouter.ai/models).

## Features
- **Smart Usage Parser:** Paste natural-language session summaries, JSON usage payloads, or shorthand (e.g. `10M cached input`, `500k fresh input`, `50k output`) and edit any detected figure inline.
- **Live OpenRouter Pricing:** Fetches current rates directly from `https://openrouter.ai/api/v1/models` with local caching.
- **Interactive Cache Toggle & Graphics:** Flip `CACHE OFF / ON` to compare cached vs. uncached cost, inspect savings percentage, and click pins on the SVG Cost Curve.
- **Flagship List + Full Catalog Drawer:** Shows key flagship models up front with an on-demand drawer to search and pin any of the 460+ OpenRouter models.

## Running Locally
Static site — no build step required. Open `index.html` directly or serve with any static file server:

```bash
python -m http.server 8765
```
