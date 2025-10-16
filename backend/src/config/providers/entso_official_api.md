 ENTSO‑E Transparency Platform REST API, dataset “Day‑ahead prices (A44)”.

- Base endpoint: https://web-api.tp.entsoe.eu/api. You pass your API token as the securityToken query param. (transparency.entsoe.eu (https://transparency.entsoe.eu/
  content/static_content/Static%20content/web%20api/Guide_prod_backup_06_11_2024.html))
- Dataset: documentType=A44 (Day‑ahead prices). Required params: in_Domain and out_Domain (same EIC bidding‑zone code), plus either periodStart/periodEnd
  (UTC, yyyyMMddHHmm) or TimeInterval. Min response span is 1 day; max range 1 year. Returns XML with price points under TimeSeries/Period/Point/price.amount.
  (transparency.entsoe.eu (https://transparency.entsoe.eu/content/static_content/Static%20content/web%20api/Guide_prod_backup_06_11_2024.html))
- Getting an API key: create a Transparency Platform account, then request “Restful API access”; once granted, generate your token under “My Account Settings”.
  For GET calls include it as securityToken=YOUR_TOKEN. (transparency.entsoe.eu (https://transparency.entsoe.eu/content/static_content/Static%20content/web%20api/
  Guide_prod_backup_06_11_2024.html))
- Bidding‑zone EIC codes: use the plain EIC (e.g., 10YAT-APG------L for AT). Don’t include the “BZN|” prefix used by the GUI endpoint. See Appendix A.15 Areas for
  codes. (transparency.entsoe.eu (https://transparency.entsoe.eu/content/static_content/Static%20content/web%20api/Guide_prod_backup_06_11_2024.html))

Example curl (Austria, 16 Oct 2025 local delivery day):
curl -G 'https://web-api.tp.entsoe.eu/api' \
--data-urlencode 'securityToken=YOUR_TOKEN' \
--data-urlencode 'documentType=A44' \
--data-urlencode 'in_Domain=10YAT-APG------L' \
--data-urlencode 'out_Domain=10YAT-APG------L' \
--data-urlencode 'periodStart=202510162200' \
--data-urlencode 'periodEnd=202510172200'

Notes

- Values are reported as price.amount; the document carries currency and price units (EUR/MWh). Convert to EUR/kWh by dividing by 1000, or to ct/kWh by dividing by
    10. (transparency.entsoe.eu (https://transparency.entsoe.eu/content/static_content/Static%20content/web%20api/Guide_prod_backup_06_11_2024.html))
- This official A44 API is different from the newtransparency GUI endpoint you explored; the official one requires a token and returns XML. (transparency.entsoe.eu
  (https://transparency.entsoe.eu/content/static_content/Static%20content/web%20api/Guide_prod_backup_06_11_2024.html))
