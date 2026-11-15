// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { cardsFromCapture, collectSearchResults } from "@/extension/src/lib/survey";

/**
 * The collector must read the search's own results, not what else eBay or Vinted put on a results page. There is no real
 * eBay results page saved in the repo, so these are synthetic pages shaped like eBay's (a results list, then "Recently
 * viewed" and "Related searches" blocks). Add a real saved page under tests/fixtures/search/ to check real markup.
 */
const setPage = (url: string, html: string) => {
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(url);
  document.body.innerHTML = html;
};
const item = (id: number, title: string, price: string, cls = "s-item") => `
  <li class="${cls}" data-listingid="${id}">
    <a href="https://www.ebay.co.uk/itm/${id}"><div class="${cls}__title">${title}</div></a>
    <img src="https://i.ebayimg.com/images/g/${id}/s-l500.webp" />
    <span class="${cls}__price">${price}</span>
  </li>`;
const titles = (raw: ReturnType<typeof collectSearchResults>) => raw.cards.map((c) => c.title);
const URL_EBAY = "https://www.ebay.co.uk/sch/i.html?_nkw=nike+pegasus+40&_sacat=0";

const RESULTS = `
  <ul class="srp-results srp-list clearfix">
    ${item(1, "Nike Pegasus 40 UK 9 white", "£30.00")}
    ${item(2, "Nike Air Zoom Pegasus 40 black", "£45.00")}
    ${item(3, "Nike Pegasus 40 grey size 10", "£38.00")}
  </ul>`;

describe("eBay: only the search's results", () => {
  it("leaves out a Recently viewed block after the list", () => {
    setPage(URL_EBAY, `<main>${RESULTS}</main>
      <section class="merch-recent"><h2>Recently viewed items</h2><ul>${item(90, "Nike Pegasus 40 red", "£5.00")}${item(91, "Nike Pegasus 40 pink", "£6.00")}</ul></section>`);
    expect(titles(collectSearchResults())).toEqual(["Nike Pegasus 40 UK 9 white", "Nike Air Zoom Pegasus 40 black", "Nike Pegasus 40 grey size 10"]);
  });

  it("leaves out related searches and carousels, even when their markup looks like result cards", () => {
    setPage(URL_EBAY, `<main>${RESULTS}
      <div class="srp-related-searches"><h3>Related searches</h3><ul>${item(92, "Nike Pegasus 41", "£50.00")}</ul></div>
      <div class="carousel"><ul>${item(93, "Nike Pegasus 39", "£20.00")}</ul></div>
      <section><h2>You may also like</h2><ul>${item(94, "Nike Vomero 17 Pegasus", "£60.00")}</ul></section></main>`);
    expect(titles(collectSearchResults())).toHaveLength(3);
  });

  it("stops at 'Results matching fewer words'", () => {
    setPage(URL_EBAY, `<ul class="srp-results">
        ${item(1, "Nike Pegasus 40 white", "£30.00")}
        <li class="srp-river-answer srp-river-answer--REWRITE_START"><h2>Results matching fewer words</h2></li>
        ${item(2, "Nike trainers Pegasus", "£10.00")}
      </ul>`);
    expect(titles(collectSearchResults())).toEqual(["Nike Pegasus 40 white"]);
  });

  it("with no known results container, keeps the largest group of cards, not the strays", () => {
    setPage(URL_EBAY, `<div class="page">
        <ol class="river">${item(1, "Nike Pegasus 40 white", "£30.00")}${item(2, "Nike Pegasus 40 black", "£31.00")}${item(3, "Nike Pegasus 40 grey", "£32.00")}${item(4, "Nike Pegasus 40 navy", "£33.00")}</ol>
        <ol class="strip">${item(98, "Nike Pegasus 40 red", "£3.00")}</ol></div>`);
    expect(titles(collectSearchResults())).toEqual(["Nike Pegasus 40 white", "Nike Pegasus 40 black", "Nike Pegasus 40 grey", "Nike Pegasus 40 navy"]);
  });

  it("drops cards that share no word with a multi-word search", () => {
    setPage(URL_EBAY, `<ul class="srp-results">${item(1, "Nike Pegasus 40 white", "£30.00")}${item(2, "Adidas Samba OG", "£50.00")}${item(3, "Nike running shoes", "£20.00")}</ul>`);
    expect(titles(collectSearchResults())).toEqual(["Nike Pegasus 40 white", "Nike running shoes"]);
    // A one-word search can't tell, so nothing is dropped.
    setPage("https://www.ebay.co.uk/sch/i.html?_nkw=trainers", `<ul class="srp-results">${item(1, "Adidas Samba OG", "£50.00")}</ul>`);
    expect(titles(collectSearchResults())).toEqual(["Adidas Samba OG"]);
  });

  it("a heading is only a boundary when it names a foreign block", () => {
    setPage(URL_EBAY, `<main><h1>3,000 results for nike pegasus 40</h1>${RESULTS}</main>`);
    expect(titles(collectSearchResults())).toHaveLength(3);
  });
});

describe("Vinted: the results grid, not stale page data", () => {
  const card = (id: number, title: string) => `<div class="feed-grid__item"><div data-testid="product-item-id-${id}">
    <a href="https://www.vinted.co.uk/items/${id}-x" title="${title}, brand: Nike, condition: Good, £20.00, £21.45 includes Buyer Protection"></a>
    <p data-testid="product-item-id-${id}--price-text">£20.00</p></div></div>`;
  const stale = `<script type="application/json">${JSON.stringify({ items: [{ id: 999, title: "Nike Pegasus 40 from an earlier search", url: "https://www.vinted.co.uk/items/999-old", price: { amount: "9.00", currency_code: "GBP" }, photo: { url: "https://images1.vinted.net/t/9/x.webp" } }] })}</script>`;

  it("ignores cards outside the feed grid", () => {
    setPage("https://www.vinted.co.uk/catalog?search_text=nike+pegasus+40", `<div class="feed-grid">${card(1, "Nike Pegasus 40 white")}</div><div class="recently-viewed"><div data-testid="product-item-id-77"><a href="https://www.vinted.co.uk/items/77-x" title="Nike Pegasus 40 old, brand: Nike, £5.00"></a></div></div>`);
    expect(titles(collectSearchResults())).toEqual(["Nike Pegasus 40 white"]);
  });

  it("page data fills in drawn cards but does not add items the page didn't draw", () => {
    setPage("https://www.vinted.co.uk/catalog?search_text=nike+pegasus+40", `<div class="feed-grid">${card(1, "Nike Pegasus 40 white")}</div>${stale}`);
    const raw = collectSearchResults();
    expect(cardsFromCapture(raw, "vinted", "2026-11-14T10:00:00.000Z").map((c) => c.id)).toEqual(["1"]);
  });

  it("page data is the source only when nothing was drawn yet", () => {
    setPage("https://www.vinted.co.uk/catalog?search_text=nike+pegasus+40", `<div class="feed-grid"></div>${stale}`);
    expect(cardsFromCapture(collectSearchResults(), "vinted", "2026-11-14T10:00:00.000Z").map((c) => c.id)).toEqual(["999"]);
  });
});
