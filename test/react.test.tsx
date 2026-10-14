import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NemiAuth } from "../src/auth";
import { NemiProvider, SignInWithNemiButton, useNemi } from "../src/react";
import { CLIENT_ID, mockFetch } from "./helpers";

describe("@guuslab/nemi/react", () => {
  it("renders an accessible dark pill button by default", () => {
    const html = renderToStaticMarkup(<SignInWithNemiButton />);
    expect(html).toMatch(/^<button type="button"/);
    expect(html).toContain("Sign in with Nemi");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("background:#000000");
    expect(html).toContain("border-radius:9999px");
  });

  it("supports the light variant, sizes and custom labels", () => {
    const html = renderToStaticMarkup(<SignInWithNemiButton variant="light" size="lg" label="Continue with Nemi" />);
    expect(html).toContain("background:#ffffff");
    expect(html).toContain("height:48px");
    expect(html).toContain("Continue with Nemi");
  });

  it("provides a loading, signed out context", () => {
    const auth = new NemiAuth({ clientId: CLIENT_ID, fetch: mockFetch().fetch });
    let seen: ReturnType<typeof useNemi> | undefined;
    function Probe() {
      seen = useNemi();
      return null;
    }
    renderToStaticMarkup(
      <NemiProvider auth={auth}>
        <Probe />
      </NemiProvider>,
    );
    expect(seen).toMatchObject({ user: null, isLoading: true, isAuthenticated: false, client: null });
  });

  it("throws a clear error outside the provider", () => {
    function Probe() {
      useNemi();
      return null;
    }
    expect(() => renderToStaticMarkup(<Probe />)).toThrow(/NemiProvider/);
  });
});
