import assert from "node:assert/strict";
import {
  AmbiguousMatchError,
  chooseFanCapsResult,
  scoreFanCapsResult,
} from "../../tools/fancaps-result-score.mjs";

const target = {
  name: "ONE PIECE the movie",
  nameCn: "航海王：黄金岛大冒险",
  labelText: "航海王：黄金岛大冒险",
  date: "2000-03-04",
};
const config = { acceptFirstAmbiguous: false };

const exactResult = { title: "One Piece: The Movie", url: "https://fancaps.net/anime/showimages.php?1" };
assert.equal(
  scoreFanCapsResult(exactResult, ["one piece: the movie", "航海王：黄金岛大冒险"], target, "One Piece: The Movie"),
  100,
);

const single = chooseFanCapsResult([exactResult], target, config, ["One Piece: The Movie"], "411");
assert.equal(single.url, exactResult.url);

const multiple = chooseFanCapsResult(
  [
    { title: "One Piece", url: "https://fancaps.net/anime/showimages.php?2" },
    exactResult,
  ],
  target,
  config,
  ["One Piece: The Movie"],
  "One Piece: The Movie",
);
assert.equal(multiple.url, exactResult.url);

const higher = chooseFanCapsResult(
  [
    exactResult,
    { title: "One Piece: The Movie (2000)", url: "https://fancaps.net/anime/showimages.php?6" },
  ],
  target,
  config,
  ["One Piece: The Movie", "One Piece: The Movie (2000)"],
  "One Piece: The Movie",
);
assert.equal(higher.url, "https://fancaps.net/anime/showimages.php?6");

assert.throws(
  () => chooseFanCapsResult(
    [
      { title: "One Piece", url: "https://fancaps.net/anime/showimages.php?2" },
      { title: "One Piece", url: "https://fancaps.net/anime/showimages.php?4" },
    ],
    target,
    config,
    [],
    "One Piece",
  ),
  AmbiguousMatchError,
);

const wrongYear = { title: "One Piece (2020)", url: "https://fancaps.net/anime/showimages.php?3" };
assert.throws(
  () => chooseFanCapsResult([wrongYear], target, config, [], "One Piece"),
  AmbiguousMatchError,
);

assert.throws(
  () => chooseFanCapsResult([wrongYear], target, { acceptFirstAmbiguous: true }, [], "One Piece"),
  AmbiguousMatchError,
);

assert.throws(
  () => chooseFanCapsResult(
    [
      { title: "One Piece (2000)", url: "https://fancaps.net/anime/showimages.php?7" },
      { title: "One Piece: The Movie (2000)", url: "https://fancaps.net/anime/showimages.php?8" },
    ],
    target,
    config,
    ["One Piece (2000)", "One Piece: The Movie (2000)"],
    "One Piece",
  ),
  AmbiguousMatchError,
);

const partial = { title: "One Piece", url: "https://fancaps.net/anime/showimages.php?5" };
const queryExact = chooseFanCapsResult([partial], target, config, [], "One Piece");
assert.equal(queryExact.url, partial.url);

console.log("fancaps result scoring tests: ok");
