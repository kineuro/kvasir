// SPDX-License-Identifier: AGPL-3.0-only
// Reasoning a model leaves in its text, read apart from its answer: each family's
// markers, a prompt that opened the thinking, stop tokens, and the same result
// however the stream is cut.

import { describe, expect, it } from "vitest";
import { type InlineReasoning, ReasoningSplitter, type Segment, splitReasoning } from "../src/reasoning.js";

/** The splitter over a text cut into pieces of a given size, joined back by kind. */
function streamed(text: string, size: number, mode: Exclude<InlineReasoning, "off"> = "markers") {
  const splitter = new ReasoningSplitter(mode);
  const segments: Segment[] = [];
  for (let i = 0; i < text.length; i += size) segments.push(...splitter.push(text.slice(i, i + size)));
  segments.push(...splitter.end());
  const of = (kind: Segment["kind"]) =>
    segments
      .filter((s) => s.kind === kind)
      .map((s) => s.text)
      .join("");
  return { thinking: of("thinking").trim(), text: of("text").trim() };
}

const CASES: [string, string, { thinking: string; text: string }][] = [
  [
    "Qwen and DeepSeek",
    "<think>\nCounting the subjects.\n</think>\n\nThere are 38.",
    { thinking: "Counting the subjects.", text: "There are 38." },
  ],
  ["an empty block", "<think>\n\n</think>\n\nHello.", { thinking: "", text: "Hello." }],
  ["space before the opener", "\n\n<think>a</think>b", { thinking: "a", text: "b" }],
  [
    "Gemma 4",
    "<|channel>thought\nWeighing the sessions.<channel|>The answer is 12.<turn|>",
    { thinking: "Weighing the sessions.", text: "The answer is 12." },
  ],
  [
    "gpt-oss harmony",
    "<|channel|>analysis<|message|>Need the count.<|end|><|start|>assistant<|channel|>final<|message|>38 subjects.<|return|>",
    { thinking: "Need the count.", text: "38 subjects." },
  ],
  [
    "harmony with a preamble and two analyses",
    "<|channel|>analysis<|message|>One.<|end|><|start|>assistant<|channel|>commentary<|message|>Looking it up.<|end|><|start|>assistant<|channel|>analysis<|message|>Two.<|end|><|start|>assistant<|channel|>final<|message|>Done.",
    { thinking: "One.Looking it up.Two.", text: "Done." },
  ],
  ["Mistral", "[THINK]Short thought.[/THINK]The reply.", { thinking: "Short thought.", text: "The reply." }],
  [
    "Cohere",
    "<|START_THINKING|>A plan.<|END_THINKING|><|START_RESPONSE|>The reply.<|END_RESPONSE|>",
    { thinking: "A plan.", text: "The reply." },
  ],
  [
    "Kimi K3",
    "<|open|>think<|sep|>Hmm.<|close|>think<|sep|><|open|>response<|sep|>Yes.<|close|>response<|sep|><|close|>message<|sep|>",
    { thinking: "Hmm.", text: "Yes." },
  ],
  ["Seed", "<seed:think>Budget.</seed:think>Out.", { thinking: "Budget.", text: "Out." }],
  ["MiniMax M3", "<mm:think>Weigh.</mm:think>Out.", { thinking: "Weigh.", text: "Out." }],
  [
    "a named think tag",
    "<think:opensource>Plan.</think:opensource>Out.",
    { thinking: "Plan.", text: "Out." },
  ],
  [
    "Hunyuan's answer wrapper",
    "<think>\nx\n</think>\n<answer>\nThe answer\n</answer>",
    { thinking: "x", text: "The answer" },
  ],
  ["a stop token left at the end", "Plain answer.<|im_end|>", { thinking: "", text: "Plain answer." }],
  [
    "a tag in the middle is the answer's",
    "The tag <think> marks reasoning.",
    { thinking: "", text: "The tag <think> marks reasoning." },
  ],
  ["an unfinished marker at the end stays text", "Hello <|im", { thinking: "", text: "Hello <|im" }],
  ["a block still open when the stream ends", "<think>still going", { thinking: "still going", text: "" }],
  ["no markers at all", "Cohort A holds 38 subjects.", { thinking: "", text: "Cohort A holds 38 subjects." }],
];

describe("reasoning read apart from the answer", () => {
  it.each(CASES)("%s", (_, text, expected) => {
    expect(splitReasoning(text)).toEqual(expected);
  });

  it("gives the same result however the stream is cut", () => {
    for (const [, text, expected] of CASES) {
      for (const size of [1, 2, 3, 5, 8, 13])
        expect(streamed(text, size), `${text} in pieces of ${size}`).toEqual(expected);
    }
  });

  it("reads a prompt that opened the thinking from the start of the output to its closing marker", () => {
    expect(streamed("Counting.\n</think>\n\n38.", 3, "open")).toEqual({ thinking: "Counting.", text: "38." });
    expect(streamed("<think>\nx</think>y", 2, "open")).toEqual({ thinking: "x", text: "y" });
    expect(streamed("Weighing.<channel|>Done.", 4, "open")).toEqual({ thinking: "Weighing.", text: "Done." });
    // a whole text with a lone closing marker reads the same way
    expect(splitReasoning("Counting.\n</think>\n\n38.")).toEqual({ thinking: "Counting.", text: "38." });
  });

  it("leaves a closing marker quoted in code to the answer", () => {
    expect(splitReasoning("Close it with `</think>` like this.")).toEqual({
      thinking: "",
      text: "Close it with `</think>` like this.",
    });
    expect(splitReasoning("```xml\n</think>\n```")).toEqual({ thinking: "", text: "```xml\n</think>\n```" });
  });

  it("holds back only what could still become a marker, and never goes back into reasoning once the answer began", () => {
    const splitter = new ReasoningSplitter();
    expect(splitter.push("<thi")).toEqual([]);
    expect(splitter.push("nk>Plan</th")).toEqual([{ kind: "thinking", text: "Plan" }]);
    expect(splitter.push("ink>\n\nAns")).toEqual([{ kind: "text", text: "Ans" }]);
    expect(splitter.push("wer <think>no</think>")).toEqual([{ kind: "text", text: "wer <think>no</think>" }]);
    expect(splitter.push(" end<|im_")).toEqual([{ kind: "text", text: " end" }]);
    expect(splitter.end()).toEqual([{ kind: "text", text: "<|im_" }]);
    const plain = new ReasoningSplitter();
    expect(plain.push("Hello")).toEqual([{ kind: "text", text: "Hello" }]);
  });
});
