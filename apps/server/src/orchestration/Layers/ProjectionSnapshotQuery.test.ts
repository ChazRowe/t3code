import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import {
  CONTEXT_CLEARED_ACTIVITY_KIND,
  PROVIDER_CONTEXT_CLEARED_ACTIVITY_KIND,
} from "../contextClearMarker.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("hydrates read model from projection tables and computes snapshot sequence", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-1',
          '2026-02-24T00:00:04.000Z',
          1,
          0,
          0,
          '2026-02-24T00:00:02.000Z',
          '2026-02-24T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-1',
          'thread-1',
          'turn-1',
          'assistant',
          'hello from projection',
          0,
          '2026-02-24T00:00:04.000Z',
          '2026-02-24T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES (
          'plan-1',
          'thread-1',
          'turn-1',
          '# Ship it',
          '2026-02-24T00:00:05.500Z',
          'thread-2',
          '2026-02-24T00:00:05.000Z',
          '2026-02-24T00:00:05.500Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES (
          'activity-1',
          'thread-1',
          'turn-1',
          'info',
          'runtime.note',
          'provider started',
          '{"stage":"start"}',
          '2026-02-24T00:00:06.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-1',
          'running',
          'codex',
          'provider-session-1',
          'provider-thread-1',
          'approval-required',
          'turn-1',
          NULL,
          '2026-02-24T00:00:07.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-1',
          'turn-1',
          NULL,
          'thread-1',
          'plan-1',
          'message-1',
          'completed',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          1,
          'checkpoint-1',
          'ready',
          '[{"path":"README.md","kind":"modified","additions":2,"deletions":1}]'
        )
      `;

      let sequence = 5;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `;
        sequence += 1;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.equal(snapshot.snapshotSequence, 5);
      assert.equal(snapshot.updatedAt, "2026-02-24T00:00:09.000Z");
      assert.deepEqual(snapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
          deletedAt: null,
        },
      ]);
      assert.deepEqual(snapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          deletedAt: null,
          messages: [
            {
              id: asMessageId("message-1"),
              role: "assistant",
              text: "hello from projection",
              turnId: asTurnId("turn-1"),
              streaming: false,
              createdAt: "2026-02-24T00:00:04.000Z",
              updatedAt: "2026-02-24T00:00:05.000Z",
            },
          ],
          proposedPlans: [
            {
              id: "plan-1",
              turnId: asTurnId("turn-1"),
              planMarkdown: "# Ship it",
              implementedAt: "2026-02-24T00:00:05.500Z",
              implementationThreadId: ThreadId.make("thread-2"),
              createdAt: "2026-02-24T00:00:05.000Z",
              updatedAt: "2026-02-24T00:00:05.500Z",
            },
          ],
          activities: [
            {
              id: asEventId("activity-1"),
              tone: "info",
              kind: "runtime.note",
              summary: "provider started",
              payload: { stage: "start" },
              turnId: asTurnId("turn-1"),
              createdAt: "2026-02-24T00:00:06.000Z",
            },
          ],
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-1"),
              status: "ready",
              files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
              assistantMessageId: asMessageId("message-1"),
              completedAt: "2026-02-24T00:00:08.000Z",
            },
          ],
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            backgroundWork: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
          unattendedRun: null,
        },
      ]);

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.snapshotSequence, 5);
      assert.deepEqual(shellSnapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
        },
      ]);
      assert.deepEqual(shellSnapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            backgroundWork: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
          latestUserMessageAt: "2026-02-24T00:00:04.000Z",
          hasPendingApprovals: true,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          unattendedRun: null,
          hasSubagents: false,
          liveSubagentCount: 0,
        },
      ]);

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value, snapshot.threads[0]);
      }
    }),
  );

  it.effect("keeps archived threads out of the main shell snapshot", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-archive-test',
          'Archive Test',
          '/tmp/archive-test',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T00:00:00.000Z',
          '2026-04-06T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-active',
            'project-archive-test',
            'Active Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:02.000Z',
            '2026-04-06T00:00:03.000Z',
            NULL,
            NULL
          ),
          (
            'thread-archived',
            'project-archive-test',
            'Archived Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:04.000Z',
            '2026-04-06T00:00:05.000Z',
            '2026-04-06T00:00:06.000Z',
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 4, '2026-04-06T00:00:07.000Z')
      `;

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepEqual(
        shellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-active")],
      );

      const archivedShellSnapshot = yield* snapshotQuery.getArchivedShellSnapshot();
      assert.deepEqual(
        archivedShellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-archived")],
      );
      assert.equal(archivedShellSnapshot.threads[0]?.archivedAt, "2026-04-06T00:00:06.000Z");
    }),
  );

  it.effect(
    "hides cross-provider subagent threads from the shell snapshot but keeps them in the read model",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_state`;

        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            scripts_json, created_at, updated_at, deleted_at
          ) VALUES (
            'project-1', 'Project 1', '/tmp/project-1',
            '{"provider":"codex","model":"gpt-5-codex"}', '[]',
            '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
          )
        `;
        // A normal thread and a subagent thread (parent_thread_id set).
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, branch, worktree_path, parent_thread_id, latest_turn_id,
            latest_user_message_at, pending_approval_count, pending_user_input_count,
            has_actionable_proposed_plan, created_at, updated_at, archived_at, deleted_at
          ) VALUES
            (
              'thread-normal', 'project-1', 'Normal',
              '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
              NULL, NULL, NULL, NULL, NULL, 0, 0, 0,
              '2026-06-20T00:00:02.000Z', '2026-06-20T00:00:03.000Z', NULL, NULL
            ),
            (
              'thread-subagent', 'project-1', 'codex: do it',
              '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
              NULL, NULL, 'thread-normal', NULL, NULL, 0, 0, 0,
              '2026-06-20T00:00:04.000Z', '2026-06-20T00:00:05.000Z', NULL, NULL
            )
        `;
        yield* sql`
          INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 4, '2026-06-20T00:00:07.000Z')
        `;

        // Shell (sidebar) snapshot excludes the subagent thread.
        const shell = yield* snapshotQuery.getShellSnapshot();
        assert.deepEqual(
          shell.threads.map((t) => t.id),
          [ThreadId.make("thread-normal")],
        );

        // The command/read model still includes it (so the decider's requireThread
        // passes for the child's own activity appends).
        const readModel = yield* snapshotQuery.getSnapshot();
        assert.isTrue(readModel.threads.some((t) => t.id === ThreadId.make("thread-subagent")));
      }),
  );

  it.effect(
    "reads targeted project, thread, and count queries without hydrating the full snapshot",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_turns`;

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-active',
            'Active Project',
            '/tmp/workspace',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:01.000Z',
            NULL
          ),
          (
            'project-deleted',
            'Deleted Project',
            '/tmp/deleted',
            NULL,
            '[]',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:03.000Z',
            '2026-03-01T00:00:04.000Z'
          )
      `;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-first',
            'project-active',
            'First Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:05.000Z',
            '2026-03-01T00:00:06.000Z',
            NULL,
            NULL
          ),
          (
            'thread-second',
            'project-active',
            'Second Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:07.000Z',
            '2026-03-01T00:00:08.000Z',
            NULL,
            NULL
          ),
          (
            'thread-deleted',
            'project-active',
            'Deleted Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:09.000Z',
            '2026-03-01T00:00:10.000Z',
            NULL,
            '2026-03-01T00:00:11.000Z'
          )
      `;

        const counts = yield* snapshotQuery.getCounts();
        assert.deepEqual(counts, {
          projectCount: 2,
          threadCount: 3,
        });

        const project = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/workspace");
        assert.equal(project._tag, "Some");
        if (project._tag === "Some") {
          assert.equal(project.value.id, asProjectId("project-active"));
        }

        const missingProject = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/missing");
        assert.equal(missingProject._tag, "None");

        const firstThreadId = yield* snapshotQuery.getFirstActiveThreadIdByProjectId(
          asProjectId("project-active"),
        );
        assert.equal(firstThreadId._tag, "Some");
        if (firstThreadId._tag === "Some") {
          assert.equal(firstThreadId.value, ThreadId.make("thread-first"));
        }
      }),
  );

  it.effect("reads single-thread checkpoint context without hydrating unrelated threads", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-context',
          'Context Project',
          '/tmp/context-workspace',
          NULL,
          '[]',
          '2026-03-02T00:00:00.000Z',
          '2026-03-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-context',
          'project-context',
          'Context Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          'feature/perf',
          '/tmp/context-worktree',
          NULL,
          '2026-03-02T00:00:02.000Z',
          '2026-03-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-context',
            'turn-1',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            1,
            'checkpoint-a',
            'ready',
            '[]'
          ),
          (
            'thread-context',
            'turn-2',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            2,
            'checkpoint-b',
            'ready',
            '[]'
          )
      `;

      const context = yield* snapshotQuery.getThreadCheckpointContext(
        ThreadId.make("thread-context"),
      );
      assert.equal(context._tag, "Some");
      if (context._tag === "Some") {
        assert.deepEqual(context.value, {
          threadId: ThreadId.make("thread-context"),
          projectId: asProjectId("project-context"),
          workspaceRoot: "/tmp/context-workspace",
          worktreePath: "/tmp/context-worktree",
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-a"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:04.000Z",
            },
            {
              turnId: asTurnId("turn-2"),
              checkpointTurnCount: 2,
              checkpointRef: asCheckpointRef("checkpoint-b"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:05.000Z",
            },
          ],
        });
      }
    }),
  );

  it.effect("keeps thread detail activity ordering consistent with shell snapshot ordering", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-01T00:00:02.000Z',
          '2026-04-01T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-unsequenced',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'unsequenced first',
            '{"source":"unsequenced"}',
            NULL,
            '2026-04-01T00:00:06.000Z'
          ),
          (
            'activity-sequence-2',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence two',
            '{"source":"sequence-2"}',
            2,
            '2026-04-01T00:00:04.000Z'
          ),
          (
            'activity-sequence-1',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence one',
            '{"source":"sequence-1"}',
            1,
            '2026-04-01T00:00:05.000Z'
          )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));

      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value.activities, snapshot.threads[0]?.activities ?? []);
      }

      assert.deepEqual(snapshot.threads[0]?.activities ?? [], [
        {
          id: asEventId("activity-unsequenced"),
          tone: "info",
          kind: "runtime.note",
          summary: "unsequenced first",
          payload: { source: "unsequenced" },
          turnId: null,
          createdAt: "2026-04-01T00:00:06.000Z",
        },
        {
          id: asEventId("activity-sequence-1"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence one",
          payload: { source: "sequence-1" },
          turnId: null,
          sequence: 1,
          createdAt: "2026-04-01T00:00:05.000Z",
        },
        {
          id: asEventId("activity-sequence-2"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence two",
          payload: { source: "sequence-2" },
          turnId: null,
          sequence: 2,
          createdAt: "2026-04-01T00:00:04.000Z",
        },
      ]);
    }),
  );

  it.effect("uses projection_threads.latest_turn_id for targeted thread latest turn queries", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-02T00:00:00.000Z',
          '2026-04-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-02T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-02T00:00:02.000Z',
          '2026-04-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-02T00:00:05.000Z',
            '2026-04-02T00:00:06.000Z',
            '2026-04-02T00:00:20.000Z',
            5,
            'checkpoint-5',
            'ready',
            '[]'
          ),
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-02T00:00:30.000Z',
            '2026-04-02T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      const threadShell = yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-1"));
      assert.equal(threadShell._tag, "Some");
      if (threadShell._tag === "Some") {
        assert.equal(threadShell.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadShell.value.latestTurn?.state, "running");
        assert.equal(threadShell.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.equal(threadDetail.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadDetail.value.latestTurn?.state, "running");
        assert.equal(threadDetail.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }
    }),
  );

  it.effect("uses projection_threads.latest_turn_id for bulk command and shell snapshots", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-03T00:00:00.000Z',
          '2026-04-03T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-03T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-03T00:00:02.000Z',
          '2026-04-03T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-03T00:00:30.000Z',
            '2026-04-03T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-03T00:00:05.000Z',
            '2026-04-03T00:00:06.000Z',
            '2026-04-03T00:00:20.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 3, '2026-04-03T00:00:40.000Z')
      `;

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(commandReadModel.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(commandReadModel.threads[0]?.latestTurn?.state, "running");

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(shellSnapshot.threads[0]?.latestTurn?.state, "running");

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.state, "running");
    }),
  );

  it.effect("keeps deleted project and thread tombstones in the command read model", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-deleted',
          'Deleted Project',
          '/tmp/deleted-project',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-05T00:00:00.000Z',
          '2026-04-05T00:00:01.000Z',
          '2026-04-05T00:00:02.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-deleted',
          'project-deleted',
          'Deleted Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-deleted',
          NULL,
          0,
          0,
          0,
          '2026-04-05T00:00:03.000Z',
          '2026-04-05T00:00:04.000Z',
          NULL,
          '2026-04-05T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-deleted',
          'turn-deleted',
          'message-deleted-user',
          NULL,
          NULL,
          'message-deleted-assistant',
          'completed',
          '2026-04-05T00:00:04.100Z',
          '2026-04-05T00:00:04.200Z',
          '2026-04-05T00:00:04.300Z',
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(commandReadModel.projects[0]?.id, asProjectId("project-deleted"));
      assert.equal(commandReadModel.projects[0]?.deletedAt, "2026-04-05T00:00:02.000Z");
      assert.equal(commandReadModel.threads[0]?.id, ThreadId.make("thread-deleted"));
      assert.equal(commandReadModel.threads[0]?.deletedAt, "2026-04-05T00:00:05.000Z");
      assert.equal(commandReadModel.threads[0]?.latestTurn?.turnId, asTurnId("turn-deleted"));
      assert.equal(commandReadModel.threads[0]?.latestTurn?.state, "completed");

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(fullSnapshot.threads[0]?.id, ThreadId.make("thread-deleted"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-deleted"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.state, "completed");

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.projects.length, 0);
      assert.equal(shellSnapshot.threads.length, 0);
    }),
  );

  it.effect("excludes subagent-child activities from the thread-detail snapshot", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-06-20T00:00:00.000Z',
          '2026-06-20T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          has_subagents,
          live_subagent_count,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          0,
          0,
          '2026-06-20T00:00:02.000Z',
          '2026-06-20T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, sequence, item_id, parent_item_id, iteration, created_at
        ) VALUES (
          'activity-root-ref', 'thread-1', 'turn-1', 'tool', 'tool.started',
          'Task started',
          '{"itemType":"collab_agent_tool_call","itemId":"item-root-1"}',
          1, 'item-root-1', NULL, NULL, '2026-06-20T00:00:01.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, sequence, item_id, parent_item_id, iteration, created_at
        ) VALUES (
          'activity-subagent-child', 'thread-1', 'turn-1', 'info', 'tool.completed',
          'Subagent message',
          '{"itemType":"assistant_message","status":"completed","parentItemId":"item-root-1","itemId":"item-child-1"}',
          2, 'item-child-1', 'item-root-1', 1, '2026-06-20T00:00:02.000Z'
        )
      `;

      const detail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.strictEqual(detail._tag, "Some");
      const ids = detail._tag === "Some" ? detail.value.activities.map((a) => a.id) : [];
      assert.ok(
        ids.includes(asEventId("activity-root-ref")),
        "root-ref activity should be present",
      );
      assert.ok(
        !ids.includes(asEventId("activity-subagent-child")),
        "child activity should be excluded",
      );

      const children = yield* snapshotQuery.listSubagentChildActivityRows({
        threadId: ThreadId.make("thread-1"),
        parentItemId: RuntimeItemId.make("item-root-1"),
      });
      assert.strictEqual(children.length, 1);
      assert.strictEqual(children[0]?.id, "activity-subagent-child");

      const roots = yield* snapshotQuery.listSubagentRootRefRows({
        threadId: ThreadId.make("thread-1"),
      });
      assert.strictEqual(roots.length, 1);
      assert.strictEqual(roots[0]?.id, "activity-root-ref");
    }),
  );

  it.effect("getSubagentTree builds refs with depth, child counts, and status", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-1', 'Project 1', '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}', '[]',
          '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id,
          latest_user_message_at, pending_approval_count, pending_user_input_count,
          has_actionable_proposed_plan, created_at, updated_at, deleted_at
        ) VALUES (
          'thread-1', 'project-1', 'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          NULL, NULL, 'turn-1', '2026-06-20T00:00:00.000Z', 0, 0, 0,
          '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
        )
      `;

      // Root subagent (depth 0): two lifecycle rows, same item_id, parent_item_id NULL.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
          created_at, item_id, parent_item_id, iteration
        ) VALUES (
          'act-root-a', 'thread-1', 'turn-1', 'tool', 'tool.started',
          'Explore: find the bug',
          '{"itemType":"collab_agent_tool_call","itemId":"item-root-a","label":"Explore: find the bug"}',
          '2026-06-20T00:00:01.000Z', 'item-root-a', NULL, 1
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
          created_at, item_id, parent_item_id, iteration
        ) VALUES (
          'act-root-a-done', 'thread-1', 'turn-1', 'tool', 'tool.completed',
          'Explore: find the bug',
          '{"itemType":"collab_agent_tool_call","itemId":"item-root-a","label":"Explore: find the bug"}',
          '2026-06-20T00:00:05.000Z', 'item-root-a', NULL, 1
        )
      `;
      // A direct (non-subagent) child of root A — must NOT become a ref.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
          created_at, item_id, parent_item_id, iteration
        ) VALUES (
          'act-child-1', 'thread-1', 'turn-1', 'tool', 'tool.completed',
          'Read file', '{"itemType":"command_execution","itemId":"item-child-1"}',
          '2026-06-20T00:00:02.000Z', 'item-child-1', 'item-root-a', 1
        )
      `;
      // Nested subagent (depth 1): collab_agent_tool_call with parent_item_id = item-root-a.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
          created_at, item_id, parent_item_id, iteration
        ) VALUES (
          'act-root-b', 'thread-1', 'turn-1', 'tool', 'tool.started',
          'Plan: design the fix',
          '{"itemType":"collab_agent_tool_call","itemId":"item-root-b","label":"Plan: design the fix"}',
          '2026-06-20T00:00:03.000Z', 'item-root-b', 'item-root-a', 1
        )
      `;

      const refs = yield* snapshotQuery.getSubagentTree({ threadId: ThreadId.make("thread-1") });

      const byItem = new Map(refs.map((r) => [r.rootItemId, r]));
      assert.strictEqual(refs.length, 2);

      const rootA = byItem.get(RuntimeItemId.make("item-root-a"));
      assert.strictEqual(rootA?.depth, 0);
      assert.strictEqual(rootA?.parentItemId, null);
      assert.strictEqual(rootA?.subagentType, "Explore");
      assert.strictEqual(rootA?.description, "find the bug");
      assert.strictEqual(rootA?.status, "completed");
      assert.strictEqual(rootA?.iteration, 1);
      assert.strictEqual(rootA?.childSubagentCount, 1);

      const rootB = byItem.get(RuntimeItemId.make("item-root-b"));
      assert.strictEqual(rootB?.depth, 1);
      assert.strictEqual(rootB?.parentItemId, "item-root-a");
      assert.strictEqual(rootB?.subagentType, "Plan");
      assert.strictEqual(rootB?.description, "design the fix");
      assert.strictEqual(rootB?.status, "inProgress");
      assert.strictEqual(rootB?.childSubagentCount, 0);
    }),
  );

  it.effect("resolves a cross-provider subagent ref + transcript from its own child thread", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;

      // Root node lives on the PARENT thread, carrying the child thread + provider
      // metadata under payload.subagentSession (as the spawn_agent handler writes it).
      yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
            created_at, item_id, parent_item_id, iteration
          ) VALUES (
            'act-cross', 'thread-1', NULL, 'tool', 'tool.completed',
            'codex: do the thing',
            ${`{"itemType":"collab_agent_tool_call","itemId":"item-cross","status":"completed","data":{"input":{"subagent_type":"codex","prompt":"do the thing"},"result":{"content":"done"}},"subagentSession":{"childThreadId":"thread-child","providerInstanceId":"codex","provider":"codex","model":"gpt-5-codex"}}`},
            '2026-06-20T00:00:01.000Z', 'item-cross', NULL, NULL
          )
        `;
      // A direct child of the node on the PARENT thread — must NOT be returned for a
      // cross-provider node (its transcript comes from the child thread instead).
      yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
            created_at, item_id, parent_item_id, iteration
          ) VALUES (
            'act-parent-child', 'thread-1', NULL, 'info', 'tool.completed', 'noise',
            '{"itemType":"command_execution","itemId":"item-noise"}',
            '2026-06-20T00:00:02.000Z', 'item-noise', 'item-cross', NULL
          )
        `;
      // The child session's transcript — plain activities on the child thread.
      yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
            created_at, item_id, parent_item_id, iteration
          ) VALUES (
            'child-1', 'thread-child', 'turn-c', 'info', 'assistant_message.completed',
            'hi', '{"itemType":"assistant_message","itemId":"c-msg-1"}',
            '2026-06-20T00:00:03.000Z', 'c-msg-1', NULL, NULL
          )
        `;
      yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
            created_at, item_id, parent_item_id, iteration
          ) VALUES (
            'child-2', 'thread-child', 'turn-c', 'info', 'assistant_message.completed',
            'done', '{"itemType":"assistant_message","itemId":"c-msg-2"}',
            '2026-06-20T00:00:04.000Z', 'c-msg-2', NULL, NULL
          )
        `;

      const refs = yield* snapshotQuery.getSubagentTree({ threadId: ThreadId.make("thread-1") });
      assert.strictEqual(refs.length, 1);
      const ref = refs[0];
      assert.strictEqual(ref?.childThreadId, "thread-child");
      assert.strictEqual(ref?.providerInstanceId, "codex");
      assert.strictEqual(ref?.provider, "codex");
      assert.strictEqual(ref?.model, "gpt-5-codex");
      assert.strictEqual(ref?.status, "completed");

      // The transcript resolves from the CHILD thread, not the parent's direct children.
      const activities = yield* snapshotQuery.getSubagentActivities({
        threadId: ThreadId.make("thread-1"),
        rootItemId: RuntimeItemId.make("item-cross"),
      });
      assert.deepStrictEqual(
        activities.map((a) => a.id),
        ["child-1", "child-2"],
      );
    }),
  );

  it.effect(
    "getSubagentTree surfaces the model for a native same-thread subagent from data.subagentSession",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_projects`;

        // A native Task/Agent subagent runs on the parent's session, so it has no
        // childThreadId/provider — but the adapter records the model it ran on inside
        // `data.subagentSession`, and the ref must surface it (provider stays null).
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
            created_at, item_id, parent_item_id, iteration
          ) VALUES (
            'act-native', 'thread-1', NULL, 'tool', 'tool.completed',
            'Explore: map the loader',
            ${`{"itemType":"collab_agent_tool_call","itemId":"item-native","status":"completed","data":{"toolName":"Agent","input":{"subagent_type":"Explore","description":"map the loader"},"result":{"content":"done"},"subagentSession":{"model":"claude-opus-4-8"}}}`},
            '2026-06-20T00:00:01.000Z', 'item-native', NULL, NULL
          )
        `;

        const refs = yield* snapshotQuery.getSubagentTree({ threadId: ThreadId.make("thread-1") });
        assert.strictEqual(refs.length, 1);
        const ref = refs[0];
        assert.strictEqual(ref?.subagentType, "Explore");
        assert.strictEqual(ref?.model, "claude-opus-4-8");
        assert.strictEqual(ref?.childThreadId, null);
        assert.strictEqual(ref?.provider, null);
        assert.strictEqual(ref?.providerInstanceId, null);
      }),
  );

  it.effect(
    "getSubagentTree scopes out subagents from a prior context once the context is cleared",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_projects`;

        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            scripts_json, created_at, updated_at, deleted_at
          ) VALUES (
            'project-1', 'Project 1', '/tmp/project-1',
            '{"provider":"codex","model":"gpt-5-codex"}', '[]',
            '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
          )
        `;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, branch, worktree_path, latest_turn_id,
            latest_user_message_at, pending_approval_count, pending_user_input_count,
            has_actionable_proposed_plan, created_at, updated_at, deleted_at
          ) VALUES (
            'thread-1', 'project-1', 'Thread 1',
            '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
            NULL, NULL, 'turn-1', '2026-06-20T00:00:00.000Z', 0, 0, 0,
            '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
          )
        `;

        // Iteration 1 subagent (before the clear).
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
            created_at, item_id, parent_item_id, iteration
          ) VALUES (
            'act-old', 'thread-1', 'turn-1', 'tool', 'tool.completed',
            'Explore: old context',
            '{"itemType":"collab_agent_tool_call","itemId":"item-old","label":"Explore: old context"}',
            '2026-06-20T00:00:01.000Z', 'item-old', NULL, 1
          )
        `;
        // Context-clear marker (iteration 1 -> 2).
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
            created_at, item_id, parent_item_id, iteration
          ) VALUES (
            'act-cleared', 'thread-1', 'turn-1', 'info', ${CONTEXT_CLEARED_ACTIVITY_KIND},
            'Context cleared', '{}',
            '2026-06-20T00:00:10.000Z', NULL, NULL, NULL
          )
        `;
        // Iteration 2 subagent (after the clear) plus a nested child of it.
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
            created_at, item_id, parent_item_id, iteration
          ) VALUES (
            'act-new', 'thread-1', 'turn-2', 'tool', 'tool.started',
            'Explore: new context',
            '{"itemType":"collab_agent_tool_call","itemId":"item-new","label":"Explore: new context"}',
            '2026-06-20T00:00:20.000Z', 'item-new', NULL, 2
          )
        `;
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
            created_at, item_id, parent_item_id, iteration
          ) VALUES (
            'act-new-nested', 'thread-1', 'turn-2', 'tool', 'tool.started',
            'Plan: new nested',
            '{"itemType":"collab_agent_tool_call","itemId":"item-new-nested","label":"Plan: new nested"}',
            '2026-06-20T00:00:21.000Z', 'item-new-nested', 'item-new', 2
          )
        `;

        const refs = yield* snapshotQuery.getSubagentTree({ threadId: ThreadId.make("thread-1") });

        const itemIds = refs.map((r) => r.rootItemId).toSorted();
        assert.deepStrictEqual(itemIds, [
          RuntimeItemId.make("item-new"),
          RuntimeItemId.make("item-new-nested"),
        ]);
        const byItem = new Map(refs.map((r) => [r.rootItemId, r]));
        // The post-clear top-level subagent keeps its nested child count.
        assert.strictEqual(byItem.get(RuntimeItemId.make("item-new"))?.childSubagentCount, 1);
      }),
  );

  it.effect("getSubagentTree scopes out subagents after a provider context-clear marker", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;

      yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            scripts_json, created_at, updated_at, deleted_at
          ) VALUES (
            'project-1', 'Project 1', '/tmp/project-1',
            '{"provider":"claude","model":"claude-opus-4-8"}', '[]',
            '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
          )
        `;
      yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, branch, worktree_path, latest_turn_id,
            latest_user_message_at, pending_approval_count, pending_user_input_count,
            has_actionable_proposed_plan, created_at, updated_at, deleted_at
          ) VALUES (
            'thread-1', 'project-1', 'Thread 1',
            '{"provider":"claude","model":"claude-opus-4-8"}', 'full-access', 'default',
            NULL, NULL, 'turn-1', '2026-06-20T00:00:00.000Z', 0, 0, 0,
            '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
          )
        `;

      // Subagent from before the user ran /clear.
      yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
            created_at, item_id, parent_item_id, iteration
          ) VALUES (
            'act-old', 'thread-1', 'turn-1', 'tool', 'tool.completed',
            'Explore: old context',
            '{"itemType":"collab_agent_tool_call","itemId":"item-old","label":"Explore: old context"}',
            '2026-06-20T00:00:01.000Z', 'item-old', NULL, NULL
          )
        `;
      // Provider context-clear marker (user ran /clear).
      yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
            created_at, item_id, parent_item_id, iteration
          ) VALUES (
            'act-cleared', 'thread-1', 'turn-1', 'info', ${PROVIDER_CONTEXT_CLEARED_ACTIVITY_KIND},
            'Context cleared', '{"state":"cleared"}',
            '2026-06-20T00:00:10.000Z', NULL, NULL, NULL
          )
        `;
      // Subagent after the clear.
      yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
            created_at, item_id, parent_item_id, iteration
          ) VALUES (
            'act-new', 'thread-1', 'turn-2', 'tool', 'tool.started',
            'Explore: new context',
            '{"itemType":"collab_agent_tool_call","itemId":"item-new","label":"Explore: new context"}',
            '2026-06-20T00:00:20.000Z', 'item-new', NULL, NULL
          )
        `;

      const refs = yield* snapshotQuery.getSubagentTree({ threadId: ThreadId.make("thread-1") });

      assert.deepStrictEqual(
        refs.map((r) => r.rootItemId),
        [RuntimeItemId.make("item-new")],
      );
    }),
  );

  it.effect(
    "getSubagentTree derives subagentType from structured tool input, not the generic summary",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_projects`;

        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            scripts_json, created_at, updated_at, deleted_at
          ) VALUES (
            'project-1', 'Project 1', '/tmp/project-1',
            '{"provider":"codex","model":"gpt-5-codex"}', '[]',
            '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
          )
        `;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, branch, worktree_path, latest_turn_id,
            latest_user_message_at, pending_approval_count, pending_user_input_count,
            has_actionable_proposed_plan, created_at, updated_at, deleted_at
          ) VALUES (
            'thread-1', 'project-1', 'Thread 1',
            '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
            NULL, NULL, 'turn-1', '2026-06-20T00:00:00.000Z', 0, 0, 0,
            '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
          )
        `;

        // Real-world shape: the `summary` column holds the generic tool title
        // ("Subagent task"); the actual subagent type + description live inside
        // payload.data.input (as the Claude provider emits them). A started-only
        // event has no `data` yet — the completed event carries it.
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
            created_at, item_id, parent_item_id, iteration
          ) VALUES (
            'act-with-input-start', 'thread-1', 'turn-1', 'tool', 'tool.started',
            'Subagent task started',
            '{"itemType":"collab_agent_tool_call","itemId":"item-a","detail":"Agent: {}"}',
            '2026-06-20T00:00:01.000Z', 'item-a', NULL, 1
          )
        `;
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
            created_at, item_id, parent_item_id, iteration
          ) VALUES (
            'act-with-input-done', 'thread-1', 'turn-1', 'tool', 'tool.completed',
            'Subagent task',
            '{"itemType":"collab_agent_tool_call","itemId":"item-a","detail":"Explore: map the loader","data":{"toolName":"Agent","input":{"subagent_type":"Explore","description":"map the loader","prompt":"trace the loader"},"result":{"content":[{"type":"text","text":"The loader is order-independent."}]}}}',
            '2026-06-20T00:00:05.000Z', 'item-a', NULL, 1
          )
        `;
        // A subagent whose latest row lacks structured data, but whose detail
        // carries the "type: description" form — must fall back to parsing it.
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
            created_at, item_id, parent_item_id, iteration
          ) VALUES (
            'act-detail-only', 'thread-1', 'turn-1', 'tool', 'tool.started',
            'Subagent task started',
            '{"itemType":"collab_agent_tool_call","itemId":"item-b","detail":"Plan: design the fix"}',
            '2026-06-20T00:00:06.000Z', 'item-b', NULL, 1
          )
        `;

        const refs = yield* snapshotQuery.getSubagentTree({
          threadId: ThreadId.make("thread-1"),
        });
        const byItem = new Map(refs.map((r) => [r.rootItemId, r]));
        assert.strictEqual(refs.length, 2);

        const fromInput = byItem.get(RuntimeItemId.make("item-a"));
        assert.strictEqual(fromInput?.subagentType, "Explore");
        assert.strictEqual(fromInput?.description, "map the loader");
        // The dispatched prompt and the text returned to the parent are surfaced.
        assert.strictEqual(fromInput?.prompt, "trace the loader");
        assert.strictEqual(fromInput?.resultText, "The loader is order-independent.");

        const fromDetail = byItem.get(RuntimeItemId.make("item-b"));
        assert.strictEqual(fromDetail?.subagentType, "Plan");
        assert.strictEqual(fromDetail?.description, "design the fix");
        assert.strictEqual(fromDetail?.prompt, null);
        assert.strictEqual(fromDetail?.resultText, null);
      }),
  );

  it.effect(
    "getSubagentTree derives status from the tool lifecycle status, not just the activity kind",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_projects`;

        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            scripts_json, created_at, updated_at, deleted_at
          ) VALUES (
            'project-1', 'Project 1', '/tmp/project-1',
            '{"provider":"codex","model":"gpt-5-codex"}', '[]',
            '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
          )
        `;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, branch, worktree_path, latest_turn_id,
            latest_user_message_at, pending_approval_count, pending_user_input_count,
            has_actionable_proposed_plan, created_at, updated_at, deleted_at
          ) VALUES (
            'thread-1', 'project-1', 'Thread 1',
            '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
            NULL, NULL, 'turn-1', '2026-06-20T00:00:00.000Z', 0, 0, 0,
            '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
          )
        `;

        // When the parent is interrupted, a subagent's last row stays kind="tool.updated"
        // but carries the real outcome in payload.status. The kind alone says inProgress;
        // the lifecycle status says failed/stopped. (sequence is NULL on these rows.)
        const insertUpdated = (activityId: string, itemId: string, status: string) => sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
            created_at, item_id, parent_item_id, iteration
          ) VALUES (
            ${activityId}, 'thread-1', 'turn-1', 'tool', 'tool.updated',
            'Subagent task',
            ${`{"itemType":"collab_agent_tool_call","itemId":"${itemId}","status":"${status}","data":{"toolName":"Agent","input":{"subagent_type":"Explore","description":"d"}}}`},
            '2026-06-20T00:00:05.000Z', ${itemId}, NULL, 1
          )
        `;
        yield* insertUpdated("act-failed", "item-failed", "failed");
        yield* insertUpdated("act-stopped", "item-stopped", "stopped");
        yield* insertUpdated("act-running", "item-running", "inProgress");

        const refs = yield* snapshotQuery.getSubagentTree({
          threadId: ThreadId.make("thread-1"),
        });
        const byItem = new Map(refs.map((r) => [r.rootItemId, r]));

        assert.strictEqual(byItem.get(RuntimeItemId.make("item-failed"))?.status, "failed");
        assert.strictEqual(byItem.get(RuntimeItemId.make("item-stopped"))?.status, "failed");
        assert.strictEqual(byItem.get(RuntimeItemId.make("item-running"))?.status, "inProgress");
      }),
  );

  it.effect(
    "getSubagentTree treats a terminal tool.completed as authoritative even when a same-timestamp tool.updated sorts after it",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_projects`;

        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            scripts_json, created_at, updated_at, deleted_at
          ) VALUES (
            'project-1', 'Project 1', '/tmp/project-1',
            '{"provider":"codex","model":"gpt-5-codex"}', '[]',
            '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
          )
        `;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, branch, worktree_path, latest_turn_id,
            latest_user_message_at, pending_approval_count, pending_user_input_count,
            has_actionable_proposed_plan, created_at, updated_at, deleted_at
          ) VALUES (
            'thread-1', 'project-1', 'Thread 1',
            '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
            NULL, NULL, 'turn-1', '2026-06-20T00:00:00.000Z', 0, 0, 0,
            '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
          )
        `;

        // Real-world shape that left subagents pulsing "running" forever: the provider
        // stamps the terminal tool.completed AND a final tool.updated (status
        // "inProgress") with the IDENTICAL created_at, and `sequence` is NULL on both.
        // Under ORDER BY (sequence, created_at, activity_id) the tool.updated activity_id
        // sorts AFTER the tool.completed, so a naive "latest row wins" derivation reports
        // inProgress forever. The terminal row must win regardless of tie-break ordering.
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
            created_at, item_id, parent_item_id, iteration
          ) VALUES (
            'act-root-a-start', 'thread-1', 'turn-1', 'tool', 'tool.started',
            'Explore: find the bug',
            '{"itemType":"collab_agent_tool_call","itemId":"item-root-a","status":"inProgress","data":{"toolName":"Agent","input":{"subagent_type":"Explore","description":"find the bug"}}}',
            '2026-06-20T00:00:01.000Z', 'item-root-a', NULL, 1
          )
        `;
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
            created_at, item_id, parent_item_id, iteration
          ) VALUES (
            'act-root-a-completed', 'thread-1', 'turn-1', 'tool', 'tool.completed',
            'Explore: find the bug',
            '{"itemType":"collab_agent_tool_call","itemId":"item-root-a","data":{"toolName":"Agent","input":{"subagent_type":"Explore","description":"find the bug"}}}',
            '2026-06-20T00:00:05.000Z', 'item-root-a', NULL, 1
          )
        `;
        // Same created_at as the completed row, but an activity_id that sorts AFTER it.
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
            created_at, item_id, parent_item_id, iteration
          ) VALUES (
            'act-root-a-zupdate', 'thread-1', 'turn-1', 'tool', 'tool.updated',
            'Explore: find the bug',
            '{"itemType":"collab_agent_tool_call","itemId":"item-root-a","status":"inProgress","data":{"toolName":"Agent","input":{"subagent_type":"Explore","description":"find the bug"}}}',
            '2026-06-20T00:00:05.000Z', 'item-root-a', NULL, 1
          )
        `;

        const refs = yield* snapshotQuery.getSubagentTree({
          threadId: ThreadId.make("thread-1"),
        });
        const root = refs.find((r) => r.rootItemId === RuntimeItemId.make("item-root-a"));
        assert.strictEqual(root?.status, "completed");
      }),
  );

  it.effect("getSubagentActivities returns only the direct children of a subagent root", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-1', 'Project 1', '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}', '[]',
          '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id,
          latest_user_message_at, pending_approval_count, pending_user_input_count,
          has_actionable_proposed_plan, created_at, updated_at, deleted_at
        ) VALUES (
          'thread-1', 'project-1', 'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          NULL, NULL, 'turn-1', '2026-06-20T00:00:00.000Z', 0, 0, 0,
          '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
        )
      `;

      // Direct child of item-root-a (kept).
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
          created_at, item_id, parent_item_id, iteration
        ) VALUES (
          'act-direct-1', 'thread-1', 'turn-1', 'tool', 'tool.completed',
          'Read file', '{"itemType":"command_execution","itemId":"item-direct-1"}',
          '2026-06-20T00:00:02.000Z', 'item-direct-1', 'item-root-a', 1
        )
      `;
      // Second direct child of item-root-a (kept).
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
          created_at, item_id, parent_item_id, iteration
        ) VALUES (
          'act-direct-2', 'thread-1', 'turn-1', 'info', 'assistant.message',
          'Found it', '{"itemType":"assistant_message","itemId":"item-direct-2"}',
          '2026-06-20T00:00:03.000Z', 'item-direct-2', 'item-root-a', 1
        )
      `;
      // Grandchild (parent_item_id = item-direct-2) → excluded.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
          created_at, item_id, parent_item_id, iteration
        ) VALUES (
          'act-grandchild', 'thread-1', 'turn-1', 'tool', 'tool.completed',
          'Deep tool', '{"itemType":"command_execution","itemId":"item-deep"}',
          '2026-06-20T00:00:04.000Z', 'item-deep', 'item-direct-2', 1
        )
      `;

      const activities = yield* snapshotQuery.getSubagentActivities({
        threadId: ThreadId.make("thread-1"),
        rootItemId: RuntimeItemId.make("item-root-a"),
      });

      assert.deepStrictEqual(
        activities.map((a) => a.id),
        ["act-direct-1", "act-direct-2"],
      );
      assert.strictEqual(activities[0]?.summary, "Read file");
    }),
  );

  it.effect("deep 2-level subagent structure: correct depths and direct-children isolation", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-1', 'Project 1', '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}', '[]',
          '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id,
          latest_user_message_at, pending_approval_count, pending_user_input_count,
          has_actionable_proposed_plan, created_at, updated_at, deleted_at
        ) VALUES (
          'thread-1', 'project-1', 'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          NULL, NULL, 'turn-1', '2026-06-20T00:00:00.000Z', 0, 0, 0,
          '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
        )
      `;

      // Level-0 root.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
          created_at, item_id, parent_item_id, iteration
        ) VALUES (
          'act-L0', 'thread-1', 'turn-1', 'tool', 'tool.started',
          'Explore: top level',
          '{"itemType":"collab_agent_tool_call","itemId":"item-L0"}',
          '2026-06-20T00:00:01.000Z', 'item-L0', NULL, 1
        )
      `;
      // Level-1 root (child subagent of L0).
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
          created_at, item_id, parent_item_id, iteration
        ) VALUES (
          'act-L1', 'thread-1', 'turn-1', 'tool', 'tool.started',
          'Plan: nested level',
          '{"itemType":"collab_agent_tool_call","itemId":"item-L1"}',
          '2026-06-20T00:00:02.000Z', 'item-L1', 'item-L0', 1
        )
      `;
      // A direct child activity of the level-1 root.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
          created_at, item_id, parent_item_id, iteration
        ) VALUES (
          'act-L1-child', 'thread-1', 'turn-1', 'tool', 'tool.completed',
          'Read file in nested',
          '{"itemType":"command_execution","itemId":"item-L1-child"}',
          '2026-06-20T00:00:03.000Z', 'item-L1-child', 'item-L1', 1
        )
      `;
      // A direct child activity of the level-0 root (must NOT show under L1).
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
          created_at, item_id, parent_item_id, iteration
        ) VALUES (
          'act-L0-child', 'thread-1', 'turn-1', 'info', 'assistant.message',
          'Top-level note', '{"itemType":"assistant_message","itemId":"item-L0-child"}',
          '2026-06-20T00:00:04.000Z', 'item-L0-child', 'item-L0', 1
        )
      `;

      const refs = yield* snapshotQuery.getSubagentTree({ threadId: ThreadId.make("thread-1") });
      const byItem = new Map(refs.map((r) => [r.rootItemId, r]));
      assert.strictEqual(refs.length, 2);
      assert.strictEqual(byItem.get(RuntimeItemId.make("item-L0"))?.depth, 0);
      assert.strictEqual(byItem.get(RuntimeItemId.make("item-L0"))?.childSubagentCount, 1);
      assert.strictEqual(byItem.get(RuntimeItemId.make("item-L1"))?.depth, 1);
      assert.strictEqual(byItem.get(RuntimeItemId.make("item-L1"))?.parentItemId, "item-L0");
      assert.strictEqual(byItem.get(RuntimeItemId.make("item-L1"))?.childSubagentCount, 0);

      const l1Activities = yield* snapshotQuery.getSubagentActivities({
        threadId: ThreadId.make("thread-1"),
        rootItemId: RuntimeItemId.make("item-L1"),
      });
      assert.strictEqual(
        l1Activities.some((a) => a.id === "act-L1-child"),
        true,
      );
      assert.strictEqual(
        l1Activities.some((a) => a.id === "act-L0-child"),
        false,
      );
    }),
  );
});

it.effect(
  "ProjectionSnapshotQuery dedupes repository identity resolution by workspace root and skips deleted projects for shell snapshots",
  () => {
    const resolveCalls: string[] = [];
    const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provideMerge(
        Layer.succeed(RepositoryIdentityResolver, {
          resolve: (cwd: string) =>
            Effect.sync(() => {
              resolveCalls.push(cwd);
              return {
                canonicalKey: `github.com/acme${cwd}`,
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: `https://github.com/acme${cwd}.git`,
                },
                rootPath: cwd,
              };
            }),
        }),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    return Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-1',
            'Shared Project 1',
            '/tmp/shared-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:00.000Z',
            '2026-04-04T00:00:01.000Z',
            NULL
          ),
          (
            'project-2',
            'Shared Project 2',
            '/tmp/shared-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:02.000Z',
            '2026-04-04T00:00:03.000Z',
            NULL
          ),
          (
            'project-3',
            'Deleted Project',
            '/tmp/deleted-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:04.000Z',
            '2026-04-04T00:00:05.000Z',
            '2026-04-04T00:00:06.000Z'
          )
      `;

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepStrictEqual(resolveCalls.toSorted(), ["/tmp/shared-root"]);
      assert.equal(shellSnapshot.projects.length, 2);
      assert.equal(shellSnapshot.projects[0]?.repositoryIdentity?.rootPath, "/tmp/shared-root");
      assert.equal(shellSnapshot.projects[1]?.repositoryIdentity?.rootPath, "/tmp/shared-root");

      resolveCalls.length = 0;

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.deepStrictEqual(resolveCalls.toSorted(), ["/tmp/deleted-root", "/tmp/shared-root"]);
      assert.equal(fullSnapshot.projects.length, 3);
      assert.equal(fullSnapshot.projects[2]?.repositoryIdentity?.rootPath, "/tmp/deleted-root");
    }).pipe(Effect.provide(layer));
  },
);
