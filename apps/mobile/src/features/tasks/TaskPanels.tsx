import {
  buildPendingUserInputAnswers,
  isPendingUserInputOptionSelected,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import {
  seedUserInputDraftAnswers,
  type ThreadUserInputQuestion,
} from "@t3tools/client-runtime/state/thread-requests";
import type { RuntimeRequestId } from "@t3tools/contracts";
import { useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import type { useFactoryTaskRequests } from "../../state/factoryTasks";
import { approvalAvailability, approvalCopy, type TaskAsk } from "./taskAsk";
import { TaskAssigneeChip, TaskStatePill } from "./TaskParts";
import type { TaskPill, TaskTone } from "./taskPresentation";

type Requests = Pick<
  ReturnType<typeof useFactoryTaskRequests>,
  "canRespond" | "answer" | "approveOnce" | "alwaysAllow" | "deny"
>;

export interface TaskFrameProps {
  readonly displayId: string;
  readonly title: string;
  readonly assignee: { readonly label: string; readonly monogram: string };
  readonly lines: readonly { readonly key: string; readonly text: string }[];
  readonly onBack: () => void;
  readonly card: ReactNode;
  /** The screen's actions, full width above the safe area. */
  readonly actions?: ReactNode;
}

/** Back and the display id, the title, who runs it, the card, the latest activity, the actions. */
export function TaskFrame(props: TaskFrameProps) {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-screen">
      <AppBar title={props.displayId} onBack={props.onBack} sidebar={false} />
      <KeyboardAvoidingView automaticOffset behavior="height" className="flex-1">
        <ScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: 16, padding: 16, paddingBottom: 24 }}
        >
          <Text className="text-2xl font-t3-bold" accessibilityRole="header">
            {props.title}
          </Text>
          <View className="flex-row">
            <TaskAssigneeChip label={props.assignee.label} monogram={props.assignee.monogram} />
          </View>
          {props.card}
          <View className="gap-3">
            {props.lines.map((line) => (
              <Text key={line.key} textRole="footnote" className="text-foreground-muted">
                {line.text}
              </Text>
            ))}
          </View>
        </ScrollView>
        {props.actions ? (
          <View
            className="gap-2 border-t border-border-subtle bg-screen px-4 pt-3"
            style={{ paddingBottom: Math.max(insets.bottom, 12) }}
          >
            {props.actions}
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </View>
  );
}

const CARD_TONES: Record<TaskTone, string> = {
  attention: "border-adaptive-amber-500-a25-400-a25 bg-adaptive-amber-500-a12-a16",
  danger: "border-adaptive-rose-300-a70-400-a28 bg-adaptive-rose-500-a12-a16",
  input: "border-border bg-card",
  working: "border-border bg-card",
  neutral: "border-border-subtle bg-card",
};

export function TaskCard(props: {
  readonly tone: TaskTone;
  readonly tag?: TaskPill;
  readonly heading: string;
  readonly children?: ReactNode;
}) {
  return (
    <View className={cn("gap-3 rounded-xl border p-4", CARD_TONES[props.tone])}>
      <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
        {props.tag ? <TaskStatePill pill={props.tag} /> : null}
        <Text className={cn("shrink", props.tag ? "" : "font-t3-medium")}>{props.heading}</Text>
      </View>
      {props.children}
    </View>
  );
}

const QUESTION_TAG: TaskPill = {
  label: "Question",
  tone: "attention",
  icon: "question",
  elapsed: null,
};

function QuestionField(props: {
  readonly question: ThreadUserInputQuestion;
  readonly draft: PendingUserInputDraftAnswer | undefined;
  readonly showHeader: boolean;
  readonly disabled: boolean;
  readonly onSelect: (value: string) => void;
  readonly onType: (value: string) => void;
}) {
  const { question } = props;
  return (
    <View className="gap-3">
      {props.showHeader && question.header ? (
        <Text textRole="footnote" className="text-foreground-muted">
          {question.header}
        </Text>
      ) : null}
      <Text className="text-base">{question.question}</Text>
      {question.options.map((option) => {
        const value = option.value ?? option.label;
        const selected = isPendingUserInputOptionSelected(question, props.draft, value);
        return (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled: props.disabled }}
            accessibilityLabel={option.label}
            disabled={props.disabled}
            onPress={() => props.onSelect(value)}
            className={cn(
              "min-h-11 items-center justify-center rounded-lg border px-4 py-2 active:opacity-70",
              selected ? "border-primary bg-subtle-strong" : "border-border-subtle bg-subtle",
            )}
          >
            <Text className="text-center text-base">{option.label}</Text>
          </Pressable>
        );
      })}
      {question.allowCustomAnswer !== false ? (
        <TextInput
          accessibilityLabel="Write an answer"
          multiline
          editable={!props.disabled}
          placeholder="Write an answer…"
          value={props.draft?.customAnswer ?? ""}
          onChangeText={props.onType}
          className="max-h-36 min-h-12"
        />
      ) : null}
    </View>
  );
}

/** G2: the question, its options and a reply field, with Send answer as the primary action. */
export function TaskQuestionPanel(
  props: Omit<TaskFrameProps, "card" | "actions"> & {
    readonly ask: Extract<TaskAsk, { kind: "question" }>;
    readonly agentLabel: string;
    readonly requests: Requests;
    readonly onDone: () => void;
  },
) {
  const { questions, requestId, responseCapability } = props.ask.input;
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const sending = useRef(false);
  const seeded = seedUserInputDraftAnswers(questions, drafts);
  const answers = buildPendingUserInputAnswers(questions, seeded);
  const answerable = props.requests.canRespond && responseCapability !== "not_resumable";
  const edit = (
    question: ThreadUserInputQuestion,
    change: (draft: PendingUserInputDraftAnswer | undefined) => PendingUserInputDraftAnswer,
  ) =>
    setDrafts((current) => ({
      ...current,
      [question.id]: change(seedUserInputDraftAnswers(questions, current)[question.id]),
    }));
  const send = async () => {
    if (answers === null || sending.current) return;
    sending.current = true;
    setBusy(true);
    setNote(null);
    const result = await props.requests.answer(requestId, answers);
    sending.current = false;
    setBusy(false);
    if (result?._tag === "Success") props.onDone();
    else if (result === undefined) setNote("This question can't be answered from here.");
  };
  return (
    <TaskFrame
      {...props}
      card={
        <TaskCard
          tone="attention"
          tag={QUESTION_TAG}
          heading={`${props.agentLabel} asked a question`}
        >
          {questions.map((question) => (
            <QuestionField
              key={question.id}
              question={question}
              draft={seeded[question.id]}
              showHeader={questions.length > 1}
              disabled={busy || !answerable}
              onSelect={(value) =>
                edit(question, (draft) =>
                  togglePendingUserInputOptionSelection(question, draft, value),
                )
              }
              onType={(value) =>
                edit(question, (draft) => setPendingUserInputCustomAnswer(question, draft, value))
              }
            />
          ))}
          {note ? (
            <Text textRole="footnote" className="text-danger-foreground">
              {note}
            </Text>
          ) : null}
        </TaskCard>
      }
      actions={
        <Button
          tone="primary"
          fullWidth
          label="Send answer"
          disabled={answers === null || !answerable}
          loading={busy}
          onPress={() => void send()}
        />
      }
    />
  );
}

const APPROVAL_TAG: TaskPill = {
  label: "Pending Approval",
  tone: "attention",
  icon: "dot",
  elapsed: null,
};

/** G3: who wants to run what, with Always allow in the card and Approve once and Deny below. */
export function TaskApprovalPanel(
  props: Omit<TaskFrameProps, "card" | "actions"> & {
    readonly ask: Extract<TaskAsk, { kind: "approval" }>;
    readonly requests: Requests;
    readonly onDone: () => void;
  },
) {
  const { approval } = props.ask;
  const copy = approvalCopy(approval.requestKind);
  const available = approvalAvailability(approval);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const sending = useRef(false);
  const allowed = props.requests.canRespond;
  const respond = async (send: (id: RuntimeRequestId) => ReturnType<Requests["deny"]>) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setNote(null);
    const result = await send(approval.requestId);
    sending.current = false;
    setBusy(false);
    if (result?._tag === "Success") props.onDone();
    else if (result === undefined) setNote("This request can't be answered from here.");
  };
  return (
    <TaskFrame
      {...props}
      card={
        <TaskCard tone="attention" tag={APPROVAL_TAG} heading={copy.wants}>
          {approval.detail ? (
            <View className="gap-1 rounded-lg bg-subtle px-3 py-2.5">
              <Text textRole="caption" className="text-foreground-muted">
                {copy.detailLabel}
              </Text>
              <Text selectable className="font-mono text-sm">
                {approval.detail}
              </Text>
            </View>
          ) : null}
          {approval.reason ? (
            <Text textRole="footnote" className="text-foreground-muted">
              {approval.reason}
            </Text>
          ) : null}
          {available.alwaysAllow ? (
            <Button
              fullWidth
              label="Always allow for this task"
              disabled={busy || !allowed}
              onPress={() => void respond(props.requests.alwaysAllow)}
            />
          ) : null}
          {note ? (
            <Text textRole="footnote" className="text-danger-foreground">
              {note}
            </Text>
          ) : null}
        </TaskCard>
      }
      actions={
        <>
          <Button
            tone="primary"
            fullWidth
            label="Approve once"
            disabled={busy || !allowed || !available.approve}
            onPress={() => void respond(props.requests.approveOnce)}
          />
          <Button
            tone="danger"
            fullWidth
            label="Deny"
            disabled={busy || !allowed || !available.deny}
            onPress={() => void respond(props.requests.deny)}
          />
        </>
      }
    />
  );
}
