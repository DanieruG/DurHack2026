# Detective Sleuth: Marketplace Extraction and Colour Matching

> Instruction for the coding agent. Based on two saved listing pages: eBay item `206627552126` (new Nike trainers, multiple sizes, shop seller) and Vinted item `10798990503` (used Nike P6000, private seller). Use both as test fixtures, with every seller username, seller ID, avatar URL and any personal detail replaced before committing them.

Finish and commit any work in progress first. Run the typecheck and tests after each section, and commit each section separately.

---

## 1. Principles

1. **Read the page's own structured data first,** then visible page fields, and only then ask Gemini for what is still missing.
2. **Record where every field came from:** `structured_data` (JSON-LD or page state), `page_field` (DOM), or `gemini`.
3. **Prefer data from this listing only.** Never take values from recommendations, "similar items", adverts or the seller's other items.
4. **Redact seller identity everywhere,** including URLs and script data, before anything is stored or sent to Gemini.
5. **Never guess.** A missing value stays missing, and becomes a seller question when it matters.

---

## 2. eBay item pages

### 2.1 Where the data is

| Data | Source | Notes |
| --- | --- | --- |
| Name, brand, model, price, currency, list price, condition, postage | JSON-LD `<script type="application/ld+json">` with `@type: Product` | Fixture: brand "Nike", model "Nike Revolution 6 Next Na", £54.00 (list £64.00), `NewCondition`, postage £0.00 |
| Item specifics (Brand, Colour, Department, Product Line, Model, materials, Shoe Width, any Style Code or MPN) | DOM: pair each `dt.ux-labels-values__labels` with the following `dd.ux-labels-values__values` in the "About this item" section | The same values also appear in the page state script as `"colour":{"_type":"LabelsValues",…}` |
| **All photos** | DOM gallery grid: `button.ux-image-grid-item img`, reading `src` **or** `data-src` (lazy-loaded photos only have `data-src`) | Fixture has **7** photos. **JSON-LD lists only 5. Never use JSON-LD's `image` for photos.** Cross-check the count with the "Picture X of N" labels or the `imageId` entries in the page state |
| **Size options and stock** | Page state: `"MSKU":{"_type":"VariationViewModel"…}`; read `selectMenus` (label, e.g. "UK Shoe Size") and `menuItemMap` (each option's `valueName` and `outOfStock`) | Fixture: sizes 7 to 11.5, each with its own stock flag. The visible page only shows "UK Shoe Size: Select" |
| Seller's description | An iframe from `itm.ebaydesc.com` | Not readable by the main page's content script |
| Style code | Not present on the fixture | Comes from item specifics when sellers include it, or from photos of the label |

**Full-size photo URL:** take the image ID from `/images/g/{id}/` and build `https://i.ebayimg.com/images/g/{id}/s-l1600.jpg`. Dedupe by image ID.

### 2.2 eBay requirements
- Extract in this order: JSON-LD core fields → item specifics from the DOM → photos from the gallery grid → size options from page state.
- **Description iframe:** add a content script for the `itm.ebaydesc.com` frame only if it needs no permissions beyond those we already have. Otherwise skip it and record "Seller description not captured". Report which you did.
- **Generic colour values** ("Multicoloured", "Multi", "Assorted") are weak evidence. The fixture's item specifics say "Multicoloured" while the title and photos show black and white.

### 2.3 eBay traps
- **Size is a choice, not a fact,** on multi-size listings. There is no single "listed size".
- **The seller's username appears 121 times** in the fixture: links, the description iframe URL (`seller=` parameter) and the page state. Redaction must cover all of them.
- **The search hint conflict:** the fixture was opened from a search for "nike revolution 8", but the listing is a **Revolution 6 Next Nature**. The listing's own data must win.

---

## 3. Vinted item pages

### 3.1 Where the data is

| Data | Source | Notes |
| --- | --- | --- |
| Size, condition, colour, material, upload date | Page data `attributes` plugin | Fixture: `size: "14"`, `status: "Very good"`, `color: "Grey, White"`, `material: "Suede, Mesh"`, `upload_date: "a day ago"` |
| Description | JSON-LD `description`, or the `description` plugin | Fully available |
| Title, brand, colour, category | JSON-LD `@type: Product` | **Never use JSON-LD's price** (see traps) |
| **All photos** | The item's `photos` array in the page data: `id`, `is_main`, full-size `url` (`/f800/`), `dominant_color_opaque` | Fixture has 4 photos. DOM fallback: `data-testid="item-photo-1"` to `item-photo-N` |
| **Price in GBP** | Page data `pricingServices`: `originalAskingAmount`, `buyerProtection.finalPrice`, `shipping.finalPrice`, `totalAmount`, `sellerOriginalAskingAmount` | Fixture: £20.75 asking, £1.74 protection, £8.69 postage, £22.49 total; seller listed at 40 AUD |
| Verification availability | `offline_verification_availability` plugin | Indicates whether Vinted's item verification may apply |
| DOM fallbacks | `data-testid`: `item-attributes-size`, `-status`, `-color`, `-material`, `item-price`, `item-shipping-banner-price` | Stable test IDs |

**Reading the page data:** Vinted is a Next.js app. Collect the strings from every `self.__next_f.push([1, "…"])` script, join them, then find and JSON-parse the line containing the item's `plugins` array and the line containing `pricingServices`. Plugins are named (`summary`, `attributes`, `description`, `user_info_header`, `seller_badges_info`, and so on).

### 3.2 Vinted requirements
- Extract in this order: page data (attributes, description, photos, pricing) → JSON-LD (title, brand, colour, category) → DOM fallbacks.
- **Price:** use `originalAskingAmount` in GBP as the listing price. If `sellerOriginalAskingAmount` is in another currency, record it as evidence ("Seller listed it at 40 AUD").
- **Totals:** for Vinted, compare the **total including buyer protection and postage** in the buy-new rule and warning signs, and say so ("£31.18 including protection and postage"). eBay keeps "Postage not included" unless postage is in the structured data.
- **Size system:** the size field has no system. Look for one in the description and title (`US 14`, `UK 9`, `EU 43`) and record where it came from. If none is found, fit becomes `warn` ("Size system not stated") with the seller question "Is that a UK or US size?". **Never assume UK.**
- **Verification:** if verification is indicated for the listing and any warning sign fires, the "before you pay" move suggests Vinted's verification.

### 3.3 Vinted traps
- **JSON-LD's price is in the seller's currency** (fixture: 40 AUD). Using it as pounds nearly doubles the price.
- **The seller block** (`user_info_header`, `seller_badges_info`) contains username, avatar, feedback count and badges, plus `seller_id` elsewhere. Redact all of it.
- **`dominant_color_opaque` reflects the background:** the main photo's `#E0DDD9` is the light backdrop, not the grey shoe. Weak hint only.

---

## 4. Fit check with size options (both platforms)
- **Single listed size** (typical on Vinted): convert using size charts and compare with the user's size for the brand, as now.
- **Multiple size options** (eBay variations): fit asks whether the user's size is offered and in stock.
  - Offered and in stock → `pass` ("Your size (UK 9) is available").
  - Offered but out of stock → `fail` ("Your size is out of stock").
  - Not offered → `fail`.
  - Next move when in stock: "Select UK {size} before buying."
- **Unknown size system** → `warn` plus a seller question.

---

## 5. Colour

### 5.1 The listing's colour
Determine the clicked listing's colour from these sources, strongest first, recording each as evidence:
1. **Style code** read from a label or the listing (identifies the exact colourway).
2. **Structured colour fields** (Vinted `color`, eBay item specifics), unless generic ("Multicoloured", "Multi", "Assorted").
3. **Colour words in the title.**
4. **Photo colour analysis** (5.3) on a crop of the shoe from the main photo, using the shoe's bounding box from the condition or identify step.

Output `listingColour: { names: string[], source, confidence }`, using the broad colour names in 5.3. If the sources disagree, keep the strongest and record the conflict.

### 5.2 Colour matching for new-price offers
The new-price offers shown to the user must match the clicked listing's colour where possible.

- **Query:** if a style code is known, search Shopping by style code first (it targets the exact colourway). Otherwise search by brand and model, adding the listing's main colour name to the query.
- **Check each offer's colour,** in this order:
  1. Style code in the offer title matches → `same`.
  2. Colour words in the offer title compared with `listingColour.names` → `same`, `different` or `unknown`.
  3. If still unknown, run photo colour analysis (5.3) on the offer's thumbnail. Product shots usually have plain backgrounds, so remove background pixels first.
- Each offer gets `colourMatch: "same" | "different" | "unknown"` with its evidence (title words or detected colours).
- **New-price figure:** use `same` offers when there are at least 3. Otherwise use all matching-model offers and state "Colours vary: price includes other colourways".
- **Offer cards:** show a small label per card: "Same colour", "Different colour" or "Colour unclear". Sort `same` first, then by price.
- **Buy-new next move:** only suggest an offer marked `same`, unless none exist, in which case say "Available new in a different colour from £X".
- Never present a `different` offer as the same item.

### 5.3 Photo colour analysis (helper)
Plain code in TypeScript; no Gemini call and no new language runtime.
- Input: an image buffer, and optionally a crop box.
- Downscale to about 100×100.
- **Background removal:** sample the border pixels, estimate the background colour, and discard pixels within a small colour distance of it. Also discard near-white and near-black pixels when they make up most of the border.
- Cluster the remaining pixels into 3 to 4 groups (k-means), or use `sharp`'s statistics for a quick dominant colour.
- Convert each cluster to CIELAB and map it to the nearest broad name: black, white, grey, navy, blue, red, green, brown, beige, pink, purple, orange, yellow.
- Return the top colours with their share, plus `multi` when no colour exceeds about 40%.
- Images from other sites must be read on the backend (after download) or fetched by the extension as data first; browsers block reading pixels from images on other sites.
- Treat the result as **weak evidence.** It never overrides a style code, a specific structured field or title colour words.

---

## 6. Redaction (both platforms)
- Remove seller usernames, seller IDs, avatars, ratings, feedback, badges, seller links, and seller parameters in URLs (e.g. eBay's `seller=`).
- Remove the logged-in user's greeting and account details.
- Apply redaction to page text, structured data taken from scripts, and every URL before storage and before any Gemini call.
- Fixture tests assert the fixture's seller username and seller ID appear nowhere in the capture.

---

## 7. Tests

**eBay fixture**
- JSON-LD fields (name, brand, model, £54.00, list £64.00, condition, postage £0).
- All item specifics pairs.
- **7 photos** with full-size URLs, including the lazy-loaded one with only `data-src`.
- 9 size options with stock flags; fit results for UK 9 in stock, out of stock and not offered.
- "Multicoloured" treated as weak; colour taken from the title.
- Search hint "nike revolution 8" does not change the identified model (Revolution 6 Next Nature) or raise confidence.
- Redaction.

**Vinted fixture**
- All attributes, full description, **4 photos** with full-size URLs.
- GBP price £20.75 used; JSON-LD's 40 AUD ignored; the AUD amount recorded as evidence.
- Buyer protection, postage and total.
- Size system found in the description (US 14), and the fit result for a UK 9 user.
- Size system unknown case (description edited to remove it): `warn` plus the seller question.
- Redaction.

**Colour**
- The helper on fixture images: background removed, correct broad colour names.
- Offer matching by style code, title words, thumbnail colour; the 3-offer threshold for same-colour pricing; card labels and sort order; buy-new only suggesting `same` offers.

No live API calls in tests.

---

## 8. Report
Run one eBay listing and one Vinted listing from the extension, then report for each:
1. Fields captured and each field's source.
2. Photos captured vs shown on the page.
3. Price breakdown (and original currency for Vinted).
4. Size options or size system, and the fit result for a UK 9 user.
5. `listingColour` and its source.
6. The Shopping query used, every offer with its `colourMatch` and evidence, and the new-price figure.
7. Confirmation that no seller details appear anywhere in the stored case.
