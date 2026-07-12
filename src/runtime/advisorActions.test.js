import test from "node:test";
import assert from "node:assert/strict";

import { parseAdvisorActionBlocks } from "./advisorActions.js";

test("parseAdvisorActionBlocks extracts a single action block", () => {
  const raw = [
    "Fortify the frontier, my lord.",
    "```action",
    '{"title": "Fortify the Meander", "text": "Raise border forts along the Meander valley."}',
    "```",
  ].join("\n");

  const { actions, text } = parseAdvisorActionBlocks(raw);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].title, "Fortify the Meander");
  assert.equal(actions[0].text, "Raise border forts along the Meander valley.");
  assert.equal(text, "Fortify the frontier, my lord.");
});

test("parseAdvisorActionBlocks handles multiple blocks and arrays", () => {
  const raw = [
    "Two moves:",
    "```action",
    '[{"title": "A", "text": "First order."}, {"title": "B", "text": "Second order."}]',
    "```",
    "and later",
    "```action",
    '{"title": "C", "text": "Third order."}',
    "```",
  ].join("\n");

  const { actions, text } = parseAdvisorActionBlocks(raw);
  assert.deepEqual(actions.map((a) => a.title), ["A", "B", "C"]);
  assert.equal(text, "Two moves:\n\nand later");
});

test("parseAdvisorActionBlocks leaves malformed JSON visible in the text", () => {
  const raw = "Try this:\n```action\n{not json}\n```";
  const { actions, text } = parseAdvisorActionBlocks(raw);
  assert.equal(actions.length, 0);
  assert.ok(text.includes("{not json}"));
});

test("parseAdvisorActionBlocks fills missing title from text and vice versa", () => {
  const long = "x".repeat(80);
  const fromText = parseAdvisorActionBlocks(`\`\`\`action\n{"text": "${long}"}\n\`\`\``);
  assert.equal(fromText.actions[0].title.length, 64);
  assert.ok(fromText.actions[0].title.endsWith("..."));

  const fromTitle = parseAdvisorActionBlocks('```action\n{"title": "Only title"}\n```');
  assert.equal(fromTitle.actions[0].text, "Only title");
});

test("parseAdvisorActionBlocks accepts plain-string entries", () => {
  const { actions } = parseAdvisorActionBlocks('```action\n"March the tagmata east."\n```');
  assert.equal(actions.length, 1);
  assert.equal(actions[0].text, "March the tagmata east.");
});

test("parseAdvisorActionBlocks drops empty or junk entries but keeps the block if all are junk", () => {
  const allJunk = parseAdvisorActionBlocks('```action\n[{}, "", 42]\n```');
  assert.equal(allJunk.actions.length, 0);
  assert.ok(allJunk.text.includes("```action"));

  const mixed = parseAdvisorActionBlocks('```action\n[{}, {"text": "Real order."}]\n```');
  assert.equal(mixed.actions.length, 1);
  assert.equal(mixed.text, "");
});

test("parseAdvisorActionBlocks returns plain text untouched", () => {
  const { actions, text } = parseAdvisorActionBlocks("No blocks here.");
  assert.equal(actions.length, 0);
  assert.equal(text, "No blocks here.");
});
