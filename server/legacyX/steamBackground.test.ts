import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSteamProfileMedia } from "./steamBackground";

function mockEquipped(response: Record<string, unknown>, ok = true) {
  const fetchMock = vi.fn(async () => ({ ok, json: async () => ({ response }) }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("resolveSteamProfileMedia", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps equipped Points Shop items to Steam CDN URLs", async () => {
    mockEquipped({
      profile_background: { image_large: "items/730/bg.jpg", movie_webm: "items/730/bg.webm", movie_mp4: "items/730/bg.mp4" },
      animated_avatar: { image_small: "items/730/avatar.gif", image_large: "items/730/avatar.png" },
      avatar_frame: { image_small: "items/730/frame-thumb.jpg", image_large: "items/730/frame.png" },
    });

    const media = await resolveSteamProfileMedia("76561198000000101");

    expect(media).toEqual({
      background: "https://cdn.fastly.steamstatic.com/steamcommunity/public/images/items/730/bg.jpg",
      backgroundVideo: {
        webm: "https://cdn.fastly.steamstatic.com/steamcommunity/public/images/items/730/bg.webm",
        mp4: "https://cdn.fastly.steamstatic.com/steamcommunity/public/images/items/730/bg.mp4",
      },
      animatedAvatar: "https://cdn.fastly.steamstatic.com/steamcommunity/public/images/items/730/avatar.gif",
      avatarFrame: "https://cdn.fastly.steamstatic.com/steamcommunity/public/images/items/730/frame.png",
    });
  });

  it("returns empty media for unequipped items and rejects non-Steam hosts", async () => {
    mockEquipped({ profile_background: { image_large: "https://evil.example/bg.jpg" }, animated_avatar: {}, avatar_frame: {} });

    const media = await resolveSteamProfileMedia("76561198000000102");

    expect(media).toEqual({ background: null, backgroundVideo: null, animatedAvatar: null, avatarFrame: null });
  });

  it("does not call Steam for invalid SteamIDs and survives upstream failures", async () => {
    const fetchMock = mockEquipped({}, false);

    expect(await resolveSteamProfileMedia("not-a-steam-id")).toEqual({ background: null, backgroundVideo: null, animatedAvatar: null, avatarFrame: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await resolveSteamProfileMedia("76561198000000103")).background).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
