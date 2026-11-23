# Token Spend

A lightweight, zero-dependency web app for estimating LLM API token spend using live model pricing from [OpenRouter](https://openrouter.ai/models).

## Features
- **Smart Usage Parser:** Paste raw session summaries, JSON usage payloads, or shorthand (e.g. `14.50M cached input`, `674,508 fresh input`, `65,648 output`) and edit any detected figure inline.
- **Live OpenRouter Pricing:** Fetches current rates directly from `https://openrouter.ai/api/v1/models` with local caching.
- **Interactive Cache Toggle & Graphics:** Flip `CACHE OFF / ON` to compare cached vs. uncached cost, inspect savings percentage, and click pins on the SVG Cost Curve.
- **Flagship List + Full Catalog Drawer:** Shows key flagship models up front with an on-demand drawer to search and pin any of the 470+ OpenRouter models.

## Running Locally
Static site — no build step required. Open `index.html` directly or serve with any static file server:

```bash
python -m http.server 8765
```

Previous design iterations are kept in `archive/v1/` and `archive/v2/`.
