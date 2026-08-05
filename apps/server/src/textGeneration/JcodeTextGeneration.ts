import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TextGenerationError, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import type { StructuredOutputSchema } from "@1jehuang/jcode-sdk";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";
import type { JcodeProcessManager } from "../provider/Drivers/JcodeProcessManager.ts";

type JcodeTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Jcode text generation via the private jcode daemon.
 *
 * Each call creates a throwaway session in the requested working directory,
 * runs `runStructured` (the SDK validates the JSON response against the
 * prompt's schema with Ajv and retries bounded corrections), then clears the
 * session so background text-generation never pollutes the user's transcripts.
 *
 * @module textGeneration/JcodeTextGeneration
 */
export const makeJcodeTextGeneration = Effect.fn("makeJcodeTextGeneration")(function* (
  processManager: JcodeProcessManager,
) {
  const runJcodeJson = Effect.fn("runJcodeJson")(function* <S extends Schema.Top>(input: {
    readonly operation: JcodeTextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError> {
    const client = yield* Effect.tryPromise({
      try: () => processManager.getClient(),
      catch: (cause) =>
        new TextGenerationError({
          operation: input.operation,
          detail: `Failed to obtain jcode client: ${errorMessage(cause)}`,
          cause,
        }),
    });
    const session = yield* Effect.tryPromise({
      try: () => client.createSession(input.cwd),
      catch: (cause) =>
        new TextGenerationError({
          operation: input.operation,
          detail: `Failed to create jcode session: ${errorMessage(cause)}`,
          cause,
        }),
    });
    const sessionId = session.session_id;
    try {
      // Respect the caller's model choice when the daemon will accept it;
      // otherwise the session keeps its default model.
      yield* Effect.tryPromise({
        try: () => client.setModel(sessionId, input.modelSelection.model),
        catch: (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: `jcode setModel rejected: ${errorMessage(cause)}`,
            cause,
          }),
      }).pipe(
        Effect.catch((cause) =>
          Effect.logDebug("jcode text generation setModel rejected; using session default.", {
            cause,
          }),
        ),
      );
      const schema = toJsonSchemaObject(input.outputSchemaJson) as StructuredOutputSchema<unknown>;
      const result = yield* Effect.tryPromise({
        try: () => client.runStructured(sessionId, input.prompt, { schema, maxRetries: 2 }),
        catch: (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: `jcode runStructured failed: ${errorMessage(cause)}`,
            cause,
          }),
      });
      return result.data as S["Type"];
    } finally {
      yield* Effect.tryPromise({
        try: () => client.clear(sessionId),
        catch: (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: `jcode clear failed: ${errorMessage(cause)}`,
            cause,
          }),
      }).pipe(Effect.ignore);
    }
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("JcodeTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runJcodeJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("JcodeTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runJcodeJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("JcodeTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
      });
      const generated = yield* runJcodeJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("JcodeTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
      });
      const generated = yield* runJcodeJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
