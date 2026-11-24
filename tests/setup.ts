import React from "react";
import "@testing-library/jest-dom/vitest";

// jsdom lacks these APIs, Monaco and virtualized lists probe them.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
}

if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

void React;
