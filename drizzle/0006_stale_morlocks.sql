CREATE TABLE IF NOT EXISTS "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"is_encrypted" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "routine_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"routine_id" uuid NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"response_text" text,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"schedule" jsonb NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"deliver_chat" boolean DEFAULT true NOT NULL,
	"deliver_email" boolean DEFAULT false NOT NULL,
	"email_to" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"conversation_id" uuid NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "routines" ADD CONSTRAINT "routines_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "routines" ADD CONSTRAINT "routines_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_runs_routine_idx" ON "routine_runs" USING btree ("routine_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routines_user_idx" ON "routines" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routines_next_run_idx" ON "routines" USING btree ("next_run_at");