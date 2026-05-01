CREATE TABLE IF NOT EXISTS "cu_custom_fields" (
	"custom_field_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"scope_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cu_folders" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"space_id" text NOT NULL,
	"name" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cu_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"space_id" text,
	"folder_id" text,
	"name" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cu_members" (
	"member_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text,
	"email" text,
	"role" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cu_spaces" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cu_task_custom_field_values" (
	"task_id" text NOT NULL,
	"custom_field_id" text NOT NULL,
	"value" jsonb,
	CONSTRAINT "cu_task_custom_field_values_task_id_custom_field_id_pk" PRIMARY KEY("task_id","custom_field_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cu_tasks" (
	"task_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"list_id" text NOT NULL,
	"parent_task_id" text,
	"name" text NOT NULL,
	"description" text,
	"status" text,
	"priority" integer,
	"due_date" date,
	"start_date" date,
	"completed_at" timestamp with time zone,
	"time_estimate" bigint,
	"time_spent" bigint,
	"assignees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at_clickup" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cu_workspaces" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"last_full_sync_at" timestamp with time zone,
	"last_incremental_sync_at" timestamp with time zone,
	"last_drift_count" integer DEFAULT 0 NOT NULL,
	"sync_state" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cu_folders" ADD CONSTRAINT "cu_folders_space_id_cu_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."cu_spaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cu_members" ADD CONSTRAINT "cu_members_workspace_id_cu_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."cu_workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cu_spaces" ADD CONSTRAINT "cu_spaces_workspace_id_cu_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."cu_workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cu_task_custom_field_values" ADD CONSTRAINT "cu_task_custom_field_values_task_id_cu_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."cu_tasks"("task_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cu_task_custom_field_values" ADD CONSTRAINT "cu_task_custom_field_values_custom_field_id_cu_custom_fields_custom_field_id_fk" FOREIGN KEY ("custom_field_id") REFERENCES "public"."cu_custom_fields"("custom_field_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cu_cf_scope_idx" ON "cu_custom_fields" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cu_folders_ws_idx" ON "cu_folders" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cu_folders_space_idx" ON "cu_folders" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cu_lists_ws_idx" ON "cu_lists" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cu_members_ws_idx" ON "cu_members" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cu_spaces_ws_idx" ON "cu_spaces" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cu_cfv_cf_idx" ON "cu_task_custom_field_values" USING btree ("custom_field_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cu_tasks_ws_list_status_idx" ON "cu_tasks" USING btree ("workspace_id","list_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cu_tasks_ws_due_idx" ON "cu_tasks" USING btree ("workspace_id","due_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cu_tasks_ws_completed_idx" ON "cu_tasks" USING btree ("workspace_id","completed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cu_tasks_updated_idx" ON "cu_tasks" USING btree ("updated_at_clickup");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cu_tasks_assignees_gin_idx" ON "cu_tasks" USING gin ("assignees");