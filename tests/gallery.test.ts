import { describe, expect, it } from "vitest";
import { listingPhotos, needsPageState, prepareCapture, type RawCapture } from "@/extension/src/lib/capture";
import { arraysByKey, nextFlightChunk, photosFromEmbedded, rscRows, scopedPhotoArrays } from "@/extension/src/lib/gallery";
import { listingItemId, scopeListingImages, vintedImage } from "@/lib/listingScope";

// ---------- fixtures shaped like the real pages (ids and signatures made up) ----------

const ITEM = "10023455181";
const OTHER = "10099999999";
const vintedUrl = (id: string, size: string, sig = "s1") => `https://images1.vinted.net/t/${id}/${size}/abcd1234.webp?s=${sig}${size}`;
const vintedPhoto = (id: string, main = false) => ({
  dominant_color_opaque: "#CDCECE",
  height: 1600,
  id,
  is_main: main,
  thumbnails: ["70x100", "150x210", "310x430"].map((s) => ({ type: `thumb${s}`, url: vintedUrl(id, s) })),
  url: vintedUrl(id, "f800"),
  width: 1200,
});
const PHOTO_IDS = ["05_014c5_FEbW", "05_00d95_EeZa", "04_026f5_1gz2", "01_013eb_c2wg", "01_0146a_FZ8H", "02_00b16_GDFz"];

/** Next.js app-router payload: rows "id:JSON" pushed as string chunks; the item row is split across two chunks. */
function vintedScripts(itemId: string, photoIds: string[]): string[] {
  const item = `14e:${JSON.stringify(["$", "$L150", null, { value: { id: itemId, title: "Nike Air Zoom Pegasus 36", photos: photoIds.map((p, i) => vintedPhoto(p, i === 0)) } }])}\n`;
  const other = `15a:${JSON.stringify(["$", "$L110", null, { data: { item_id: OTHER, photos: [vintedPhoto("09_other_photo")] } }])}\n`;
  const sticky = `c8:${JSON.stringify(["$", "$L110", null, { data: { data: { item_id: itemId, is_closed: false, photos: photoIds.slice(0, 2).map((p) => vintedPhoto(p)) } } }])}\n`;
  const flight = `0:["$","html",null,{}]\n${sticky}${item}${other}`;
  const cut = flight.indexOf(item) + 40;
  const push = (s: string) => `self.__next_f.push(${JSON.stringify([1, s])})`;
  return ["(self.__next_f=self.__next_f||[]).push([0])", push(flight.slice(0, cut)), push(flight.slice(cut))];
}

const jsonLd = (url: string, image: unknown) => JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Nike Air Zoom Pegasus 36", image, offers: { "@type": "Offer", url } });

const raw = (over: Partial<RawCapture> = {}): RawCapture => ({
  pageUrl: `https://www.vinted.co.uk/items/${ITEM}-nike-air-zoom-pegasus-36`,
  docTitle: "Nike Air Zoom Pegasus 36 | Vinted",
  ogTitle: null,
  h1: null,
  priceMeta: null,
  priceText: "£40.00",
  images: [],
  pageText: "Nike Air Zoom Pegasus 36",
  ...over,
});

// ---------- Vinted ----------

describe("gallery: Vinted embedded JSON (photos behind a \"+N\" tile)", () => {
  // The DOM shows 5 tiles (the 5th labelled "+ 1"); the 6th photo is never rendered.
  const dom = PHOTO_IDS.slice(0, 5).map((p) => vintedUrl(p, "f800"));

  it("reads every photo of this item from the RSC payload, at the largest size, in gallery order", () => {
    const r = raw({
      images: [vintedUrl(PHOTO_IDS[0], "f800"), ...dom, vintedUrl(PHOTO_IDS[2], "310x430")],
      embedded: { jsonLd: [jsonLd(`https://www.vinted.co.uk/items/${ITEM}-nike`, vintedUrl(PHOTO_IDS[0], "f800"))], json: [], scripts: vintedScripts(ITEM, PHOTO_IDS) },
    });
    expect(needsPageState(r)).toBe(false);
    const urls = listingPhotos(r);
    expect(urls).toEqual(PHOTO_IDS.map((p) => vintedUrl(p, "f800")));
    expect(urls.join()).not.toContain("09_other_photo"); // another item's photos in the same payload
    expect(prepareCapture(r).preview.photoCount).toBe(6);
  });

  it("decodes push chunks and parses JSON rows only", () => {
    expect(nextFlightChunk('self.__next_f.push([1,"0:[\\"$\\"]\\n"])')).toBe('0:["$"]\n');
    expect(nextFlightChunk("self.__next_f.push([0])")).toBeNull();
    expect(nextFlightChunk("console.log(1)")).toBeNull();
    expect(rscRows('0:["a"]\n1:T12,plain text\n2:{"b":1}\nnot a row')).toEqual([["a"], { b: 1 }]);
  });

  it("keeps only arrays tied to this item id", () => {
    const doc = { list: [{ id: OTHER, photos: ["https://x.test/a.jpg"] }, { item: { id: ITEM, photos: ["https://x.test/b.jpg"], seller: { id: 5, photos: ["https://x.test/c.jpg"] } } }] };
    expect(scopedPhotoArrays(doc, ITEM)).toEqual([["https://x.test/b.jpg"], ["https://x.test/c.jpg"]]);
    expect(scopedPhotoArrays({ item_id: OTHER, photos: ["https://x.test/a.jpg"] }, ITEM)).toEqual([]);
    expect(scopedPhotoArrays(doc, null)).toEqual([]);
  });

  it("ignores a JSON-LD Product for another listing", () => {
    const r = raw({ embedded: { jsonLd: [jsonLd(`https://www.vinted.co.uk/items/${OTHER}-x`, vintedUrl("09_other", "f800"))], json: [], scripts: [] } });
    expect(photosFromEmbedded(r.embedded, { pageUrl: r.pageUrl, platform: "vinted", title: "Nike" })).toEqual([]);
  });

  it("after client-side navigation the inline data is for another item: falls back to the page state (MAIN world)", () => {
    const r = raw({
      images: dom,
      embedded: { jsonLd: [], json: [], scripts: vintedScripts(OTHER, ["07_first_item"]) },
    });
    expect(needsPageState(r)).toBe(true);
    // Without the state, the DOM gallery still gives the 5 rendered photos.
    expect(listingPhotos(r)).toHaveLength(5);
    // The gallery's React props carry all 6.
    r.state = { texts: [], gallery: [JSON.stringify(PHOTO_IDS.map((p) => vintedPhoto(p)))] };
    expect(listingPhotos(r)).toEqual(PHOTO_IDS.map((p) => vintedUrl(p, "f800")));
  });

  it("page state: the decoded RSC payload and __NEXT_DATA__ are scoped by item id too", () => {
    const flight = vintedScripts(ITEM, PHOTO_IDS).map(nextFlightChunk).filter(Boolean).join("");
    const nextData = JSON.stringify({ props: { pageProps: { item: { id: Number(ITEM), photos: [vintedPhoto("08_from_next_data")] } } } });
    const r = raw({ state: { texts: [flight, nextData], gallery: [] } });
    const urls = listingPhotos(r);
    expect(urls).toHaveLength(7);
    expect(urls).toContain(vintedUrl("08_from_next_data", "f800"));
    expect(urls.join()).not.toContain("09_other_photo");
  });

  it("de-duplicates Vinted photos by image id, keeping the largest size seen", () => {
    expect(vintedImage(vintedUrl("a1", "310x430"))).toMatchObject({ id: "a1" });
    expect(vintedImage(vintedUrl("a1", "f800"))!.rank).toBeGreaterThan(vintedImage(vintedUrl("a1", "310x430"))!.rank);
    expect(vintedImage("https://images1.vinted.net/tc/a1/1699999999.jpeg?s=x")!.rank).toBeGreaterThan(vintedImage(vintedUrl("a1", "f800"))!.rank);
    expect(scopeListingImages([vintedUrl("a1", "150x210"), vintedUrl("b2", "f800"), vintedUrl("a1", "f800"), vintedUrl("a1", "70x100")], "vinted")).toEqual([
      vintedUrl("a1", "f800"),
      vintedUrl("b2", "f800"),
    ]);
  });
});

// ---------- eBay ----------

describe("gallery: eBay embedded JSON", () => {
  const ids = ["AS4AAeSw505qR4He", "yvcAAeSwts9qR4Hg", "obUAAeSwn0ZqR4Hf", "xoUAAeSwepNqR4Hg", "K1sAAeSwQ2xqR4Hh", "Zz9AAeSw7mVqR4Hi", "Qq1AAeSwAbCdEfGh", "Ww2AAeSwIjKlMnOp"];
  const ebay = (id: string, size: number, ext = ".jpg") => `https://i.ebayimg.com/images/g/${id}/s-l${size}${ext}`;
  const mediaList = ids.map((id) => ({ _type: "MediaImage", image: { originalImg: { URL: ebay(id, 1600) }, thumbnail: { URL: ebay(id, 140) } } }));
  const pageUrl = "https://www.ebay.co.uk/itm/266000000001";

  it("reads the gallery's mediaList from an inline script, full size, deduped against the DOM", () => {
    const script = `$MC=(window.$MC||[]).concat({"w":[["s0-1",0,{"model":{"PICTURE":{"_type":"PictureModule","mediaList":${JSON.stringify(mediaList)}}}}]]})`;
    const r = raw({
      pageUrl,
      // The DOM shows the first slide plus filmstrip thumbnails, and a "+3" tile over the rest.
      images: [ebay(ids[0], 1600, ".webp"), ...ids.slice(0, 5).map((id) => ebay(id, 140, ".webp")), "https://i.ebayimg.com/thumbs/images/g/Rp0AAeSwY-tq4Nzq/s-l500.jpg"],
      embedded: { jsonLd: [], json: [], scripts: [script] },
    });
    expect(listingPhotos(r)).toEqual(ids.map((id) => ebay(id, 1600)));
  });

  it("uses a JSON-LD Product image list when it names this listing", () => {
    const r = raw({ pageUrl, embedded: { jsonLd: [jsonLd(pageUrl, ids.map((id) => ebay(id, 500)))], json: [], scripts: [] } });
    expect(listingPhotos(r)).toEqual(ids.map((id) => ebay(id, 1600)));
    expect(listingItemId("https://www.ebay.co.uk/itm/nike-pegasus-40/266000000001?hash=x", "ebay")).toBe("266000000001");
  });

  it("finds arrays by key with strings and escapes respected", () => {
    const t = 'var a = {"mediaList":[{"u":"https://x.test/a].jpg"},{"u":"q\\"]"}], "z": 1};';
    expect(arraysByKey(t, "mediaList")).toEqual([[{ u: "https://x.test/a].jpg" }, { u: 'q"]' }]]);
  });
});

describe("gallery: no page data", () => {
  it("uses the gallery DOM; large page images only when the gallery wasn't recognised", () => {
    const r = raw({ pageUrl: "https://www.depop.com/products/abc", images: ["https://img.test/og.jpg"], pageImages: ["https://img.test/1.jpg", "https://img.test/2.jpg"] });
    expect(listingPhotos(r)).toEqual(["https://img.test/og.jpg", "https://img.test/1.jpg", "https://img.test/2.jpg"]);
    const withGallery = raw({ images: [vintedUrl("a1", "f800"), vintedUrl("b2", "f800")], pageImages: ["https://img.test/unrelated.jpg"] });
    expect(listingPhotos(withGallery)).toEqual([vintedUrl("a1", "f800"), vintedUrl("b2", "f800")]);
  });
});
