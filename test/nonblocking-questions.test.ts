import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApprovalBridge, extensionUiRequestFrom, type ApprovalEvent } from "../src/approvals.js";
import { AdapterServer } from "../src/server.js";
import { formQuestionAnswer, toQuestionForm } from "../src/question-forms.js";
import { V2EventTranslator } from "../src/v2.js";

const questions = [
  { id: "q1", header: "Features", question: "Which?", options: [{ label: "A" }, { label: "B" }], multiSelect: true },
  { id: "q2", header: "Details", question: "Details?", options: [], multiSelect: false },
];

function harness() {
  const events: ApprovalEvent[] = [];
  const responses: Record<string, unknown>[] = [];
  const bridge = new ApprovalBridge(
    "ses_test",
    (event) => events.push(event),
    (r) => {
      responses.push(r);
    },
    () => "msg_test",
  );
  const ask = (id: string) => {
    const request = extensionUiRequestFrom({
      id,
      method: "question",
      requestId: "native-call",
      toolCallId: "native-call",
      questions,
      waitForAnswer: false,
      deadlineAtMs: 9999999999999,
    });
    assert.ok(request);
    bridge.handle(request);
  };
  return { bridge, events, responses, ask };
}

test("nonblocking structured question survives tool and turn completion", () => {
  const h = harness();
  h.ask("connection-1");
  const card = h.bridge.questions()[0];
  assert.ok(card);
  h.bridge.noteToolEnd("native-call");
  h.bridge.finishTurn();
  assert.deepEqual(h.bridge.questions(), [card]);
  assert.equal(card.questions[0]?.multiple, true);
  assert.equal(h.bridge.hasPending("ses_test"), true);
  h.ask("connection-2");
  assert.equal(h.bridge.questions()[0]?.id, card.id);
  assert.equal(h.events.filter((e) => e.type === "question.asked").length, 1);
});

test("structured reply maps canonical IDs and refreshes the connection ID", async () => {
  const h = harness();
  h.ask("connection-1");
  const card = h.bridge.questions()[0];
  assert.ok(card);
  h.ask("connection-2");
  assert.equal(await h.bridge.replyQuestion(card.id, [["A", "B"], ["custom"]]), true);
  assert.equal(h.responses.length, 1);
  assert.equal(h.responses[0]?.uiRequestId, "connection-2");
  assert.notEqual(h.responses[0]?.id, card.id);
  assert.deepEqual(h.responses[0]?.answers, { q1: { selected: ["A", "B"] }, q2: { selected: [], text: "custom" } });
});

test("native settlements remove cards exactly once and stale snapshots cannot resurrect them", () => {
  for (const outcome of ["answered", "comment-submitted", "cancelled", "timed_out"]) {
    const h = harness();
    h.ask("connection-1");
    const card = h.bridge.questions()[0];
    assert.ok(card);
    const event = {
      type: "question_resolved",
      id: "connection-1",
      requestId: "native-call",
      outcome,
      answers: { q1: { selected: ["A"] } },
      comment: "details",
    };
    h.bridge.observeQuestion(event);
    h.bridge.observeQuestion(event);
    h.ask("connection-2");
    assert.deepEqual(h.bridge.questions(), []);
    assert.equal(h.events.length, 2);
    assert.equal(
      h.events[1]?.type,
      outcome === "cancelled" || outcome === "timed_out" ? "question.rejected" : "question.replied",
    );
    const settlement = h.events[1];
    assert.ok(settlement);
    const translated = new V2EventTranslator().translate("/tmp", settlement)[0];
    assert.equal(translated?.data.id, toQuestionForm(card).id);
    assert.equal(
      translated?.type,
      outcome === "cancelled" || outcome === "timed_out" ? "form.cancelled" : "form.replied",
    );
  }
});

test("question updates retain deadline and drafts without locally expiring the card", () => {
  const h = harness();
  h.ask("connection-1");
  h.bridge.observeQuestion({
    type: "question_updated",
    id: "connection-1",
    deadlineAtMs: 1,
    draft: { answers: { q1: { selected: ["A"] } } },
  });
  assert.equal(h.bridge.questions()[0]?.metadata?.deadlineAtMs, 1);
  assert.deepEqual(h.bridge.questions()[0]?.metadata?.draft, { answers: { q1: { selected: ["A"] } } });
  assert.equal(h.bridge.hasPending("ses_test"), true);
});

test("forms use canonical keys, custom options, partial answers and comment-only submissions", () => {
  const h = harness();
  h.ask("connection-1");
  const card = h.bridge.questions()[0];
  assert.ok(card);
  const form = toQuestionForm(card);
  assert.equal(form.fields[0]?.type, "multiselect");
  assert.deepEqual(
    form.fields.map((field) => field.key),
    ["q1", "q2"],
  );
  assert.deepEqual(formQuestionAnswer(card, { q1: ["A", "custom"] }), { answers: [["A", "custom"], []] });
  assert.deepEqual(formQuestionAnswer(card, { comment: "overall" }), { answers: [[], []], comment: "overall" });
  assert.throws(() => formQuestionAnswer(card, { q2: ["invalid"] }), /match its type/);
  assert.throws(() => formQuestionAnswer(card, { unknown: "invalid" }), /unknown form field/);
  const event = h.events[0];
  assert.ok(event);
  assert.deepEqual(new V2EventTranslator().translate("/tmp", event)[0]?.data.form, form);
});

function waitEvent(emitter: EventEmitter, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(type, onEvent);
      reject(new Error(`Timed out waiting for ${type}`));
    }, 5000);
    const onEvent = (event: Record<string, unknown>) => {
      clearTimeout(timer);
      resolve(event);
    };
    emitter.once(type, onEvent);
  });
}

async function stream(url: string) {
  const controller = new AbortController();
  const emitter = new EventEmitter();
  const history: Array<Record<string, unknown>> = [];
  const response = await fetch(url, { signal: controller.signal });
  assert.ok(response.body);
  const reader = response.body.getReader();
  const reading = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const lines = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const line = lines.split("\n").find((line) => line.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6));
          history.push(event);
          emitter.emit(event.type, event);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  return {
    history,
    next: (type: string) => waitEvent(emitter, type),
    close: async () => {
      controller.abort();
      await reading;
    },
  };
}

async function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-questions-"));
  const settings = {
    ANTECHAMBER_PI_BINARY: fileURLToPath(new URL("./fixtures/question-rpc.mjs", import.meta.url)),
    ANTECHAMBER_STATE_DIR: join(root, "state"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
  };
  const previous = Object.keys(settings).map((key) => process.env[key]);
  Object.assign(process.env, settings);
  const servers: AdapterServer[] = [];
  const start = async () => {
    const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: root });
    await server.start();
    servers.push(server);
    return server;
  };
  t.after(async () => {
    for (const server of servers) await server.stop();
    Object.keys(settings).forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
    rmSync(root, { recursive: true, force: true });
  });
  const server = await start();
  const request = (path: string, method = "GET", body?: unknown) =>
    fetch(`${server.url}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
  const created = await request("/session", "POST", {});
  const session = (await created.json()) as { id: string };
  return { server, session, start, request };
}

for (const mode of ["idle", "busy"]) {
  test(`HTTP and SSE structured replies deliver once when ${mode}`, { timeout: 20000 }, async (t) => {
    const h = await setup(t);
    const v1 = await stream(`${h.server.url}/event`);
    const v2 = await stream(`${h.server.url}/api/event`);
    t.after(() => v1.close());
    t.after(() => v2.close());
    const asked = v1.next("question.asked");
    const formCreated = v2.next("form.created");
    const managed = h.server["sessions"].get(h.session.id);
    assert.ok(managed?.pi);
    const turn = waitEvent(managed.pi, "event");
    assert.equal(
      (await h.request(`/session/${h.session.id}/prompt_async`, "POST", { parts: [{ type: "text", text: mode }] }))
        .status,
      204,
    );
    await Promise.all([asked, formCreated, turn]);
    // A round trip is a deterministic barrier after all prompt lifecycle frames.
    const before = await managed.pi.command<{ pendingQuestions: Array<{ id: string }> }>({ type: "get_state" });
    const pending = (await (await h.request("/question")).json()) as Array<{ id: string; sessionID: string }>;
    assert.equal(pending.length, 1);
    assert.equal(managed.hasPendingInteraction(), true);
    assert.equal(managed.status.type, mode === "idle" ? "idle" : "busy");
    const forms = (await (await h.request("/api/form")).json()) as { data: Array<{ id: string }> };
    const form = forms.data[0];
    const card = pending[0];
    assert.ok(form && card);
    assert.equal((await h.request(`/api/session/${h.session.id}/form/${form.id}`)).status, 200);
    assert.equal((await h.request(`/api/session/${h.session.id}/form`)).status, 200);
    assert.equal(
      (
        await h.request(`/api/session/${h.session.id}/form/${form.id}/reply`, "POST", {
          answer: { unknown: "invalid" },
        })
      ).status,
      400,
    );
    assert.equal((await h.request(`/question/${card.id}/reply`, "POST", { answers: [] })).status, 409);
    await managed.pi.command({ type: "refuse_next" });
    assert.equal((await h.request(`/question/${card.id}/reply`, "POST", { answers: [["A"], []] })).status, 409);
    assert.equal((await h.request("/question")).status, 200);
    const replied = v1.next("question.replied");
    const formReplied = v2.next("form.replied");
    const delivered = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        managed.pi?.off("event", onEvent);
        reject(new Error("answer delivery timeout"));
      }, 5000);
      const onEvent = (event: Record<string, unknown>) => {
        if (event.type !== "answer_delivered") return;
        clearTimeout(timer);
        managed.pi?.off("event", onEvent);
        resolve(event);
      };
      managed.pi?.onEvent(onEvent);
    });
    const reply =
      mode === "idle"
        ? await h.request(`/api/session/${h.session.id}/form/${form.id}/reply`, "POST", {
            answer: { q1: ["A", "B"], q2: "custom", comment: "overall" },
          })
        : await h.request(`/question/${card.id}/reply`, "POST", { answers: [[], ["custom"]], comment: "overall" });
    assert.equal(reply.status, mode === "idle" ? 204 : 200);
    const [, formEvent, delivery] = await Promise.all([replied, formReplied, delivered]);
    assert.equal(delivery.disposition, mode === "idle" ? "followUp" : "steer");
    assert.equal((formEvent.data as { id: string }).id, form.id);
    const state = await managed.pi.command<{ prompts: number; responses: Array<Record<string, unknown>> }>({
      type: "get_state",
    });
    assert.equal(state.data?.prompts, 1, "answer must not create a second prompt");
    const native = state.data?.responses.at(-1);
    assert.equal(native?.uiRequestId, before.data?.pendingQuestions[0]?.id);
    assert.notEqual(native?.id, native?.uiRequestId);
    assert.equal(native?.value, undefined);
    assert.deepEqual(
      native?.answers,
      mode === "idle"
        ? { q1: { selected: ["A", "B"] }, q2: { selected: [], text: "custom" } }
        : { q2: { selected: [], text: "custom" } },
    );
    const messages = (await (await h.request(`/session/${h.session.id}/message`)).json()) as Array<{
      info: { role: string };
    }>;
    assert.equal(
      messages.filter((m) => m.info.role === "user").length,
      2,
      "prompt and one injected answer are visible",
    );
    assert.deepEqual(await (await h.request("/question")).json(), []);
    assert.equal((await h.request(`/question/${card.id}/reply`, "POST", { answers: [["A"]] })).status, 404);
    assert.equal((await h.request(`/api/session/${h.session.id}/form/${form.id}`, "DELETE")).status, 404);
  });
}

test("revival hydrates pending questions with stable public IDs and fresh native IDs", {
  timeout: 20000,
}, async (t) => {
  const h = await setup(t);
  const managed = h.server["sessions"].get(h.session.id);
  assert.ok(managed?.pi);
  await managed.pi.command({ type: "prompt", message: "idle" });
  const old = await managed.pi.command<{ pendingQuestions: Array<{ id: string }> }>({ type: "get_state" });
  const card = h.server["sessions"].questions(h.session.id)[0];
  assert.ok(card);
  await h.server.stop();
  const restarted = await h.start();
  assert.deepEqual(restarted["sessions"].questions(h.session.id), [], "dormant scanning is deliberately omitted");
  const state = await restarted["sessions"].sessionRpc<{ pendingQuestions: Array<{ id: string }> }>(h.session.id, {
    type: "get_state",
  });
  const hydrated = restarted["sessions"].questions(h.session.id)[0];
  assert.equal(hydrated?.id, card.id);
  assert.notEqual(state.data?.pendingQuestions[0]?.id, old.data?.pendingQuestions[0]?.id);
  assert.equal(await restarted["sessions"].replyQuestion(h.session.id, card.id, [[], []], "comment only"), true);
  assert.deepEqual(restarted["sessions"].questions(h.session.id), []);
  await restarted.stop();
  const settled = await h.start();
  await settled["sessions"].sessionRpc(h.session.id, { type: "get_state" });
  assert.deepEqual(settled["sessions"].questions(h.session.id), [], "settled questions must not resurrect");
});

test("legacy questions become forms without changing native labels", () => {
  const h = harness();
  const request = extensionUiRequestFrom({ id: "legacy", method: "select", title: "Pick", options: ["A"] });
  assert.ok(request);
  h.bridge.handle(request);
  const card = h.bridge.questions()[0];
  assert.ok(card);
  const reply = formQuestionAnswer(card, { q1: "A" });
  assert.equal(h.bridge.replyQuestion(card.id, reply.answers), true);
  assert.deepEqual(h.responses, [{ type: "extension_ui_response", id: "legacy", value: "A" }]);
});

for (const action of ["v1-reject", "v2-delete", "timed_out"]) {
  test(`structured question cancellation via ${action} settles both SSE surfaces`, { timeout: 20000 }, async (t) => {
    const h = await setup(t);
    const v1 = await stream(`${h.server.url}/event`);
    const v2 = await stream(`${h.server.url}/api/event`);
    t.after(() => v1.close());
    t.after(() => v2.close());
    const asked = v1.next("question.asked");
    const created = v2.next("form.created");
    await h.request(`/session/${h.session.id}/prompt_async`, "POST", { parts: [{ type: "text", text: "idle" }] });
    await Promise.all([asked, created]);
    const manager = h.server["sessions"];
    const card = manager.questions(h.session.id)[0];
    const pi = manager.get(h.session.id)?.pi;
    assert.ok(card && pi);
    const rejected = v1.next("question.rejected");
    const cancelled = v2.next("form.cancelled");
    if (action === "timed_out") await pi.command({ type: "resolve_question", outcome: "timed_out" });
    else {
      const reply =
        action === "v1-reject"
          ? await h.request(`/question/${card.id}/reject`, "POST")
          : await h.request(`/api/session/${h.session.id}/form/${toQuestionForm(card).id}`, "DELETE");
      assert.equal(reply.status, action === "v1-reject" ? 200 : 204);
    }
    await Promise.all([rejected, cancelled]);
    const state = await pi.command<{ responses: Array<Record<string, unknown>> }>({ type: "get_state" });
    if (action !== "timed_out") assert.equal(state.data?.responses[0]?.cancelled, true);
    assert.deepEqual(manager.questions(h.session.id), []);
    assert.equal(manager.get(h.session.id)?.hasPendingInteraction(), false);
  });
}

test("snapshot hydration keeps newer live updates and explicit abort cannot resurrect a card", () => {
  const h = harness();
  h.ask("connection-1");
  h.bridge.observeQuestion({
    type: "question_updated",
    id: "connection-1",
    deadlineAtMs: 123,
    draft: { comment: "draft" },
  });
  const snapshot = [{ id: "connection-1", requestId: "native-call", questions, deadlineAtMs: 1, waitForAnswer: false }];
  h.bridge.hydrate(snapshot);
  assert.equal(h.bridge.questions()[0]?.metadata?.deadlineAtMs, 123);
  assert.deepEqual(h.bridge.questions()[0]?.metadata?.draft, { comment: "draft" });
  h.bridge.cancelAll();
  h.bridge.hydrate(snapshot);
  assert.deepEqual(h.bridge.questions(), []);
});
