CREATE TYPE "public"."subscription_term" AS ENUM('annual', 'lifetime');--> statement-breakpoint
CREATE TABLE "subscription_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"term" "subscription_term" NOT NULL,
	"stars_amount" integer NOT NULL,
	"telegram_payment_charge_id" text NOT NULL,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_payments_stars_positive" CHECK ("subscription_payments"."stars_amount" > 0)
);
--> statement-breakpoint
DROP INDEX "subscriptions_tg_charge_uq";--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "trial_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_payments_tg_charge_uq" ON "subscription_payments" USING btree ("telegram_payment_charge_id");--> statement-breakpoint
CREATE INDEX "subscription_payments_user_idx" ON "subscription_payments" USING btree ("user_id","created_at");--> statement-breakpoint
-- A trial row has no charge. Keep that end date so a later refund can restore it.
UPDATE "subscriptions" SET "trial_expires_at" = "expires_at" WHERE "telegram_payment_charge_id" IS NULL AND "expires_at" IS NOT NULL;--> statement-breakpoint
-- Copy any charge off the plan row before the column is dropped. No live charges exist.
-- stars_amount 1 only satisfies the check when a dev row is present. The term follows expires_at.
INSERT INTO "subscription_payments" ("user_id", "term", "stars_amount", "telegram_payment_charge_id")
SELECT "user_id",
  CASE WHEN "expires_at" IS NULL THEN 'lifetime'::"public"."subscription_term" ELSE 'annual'::"public"."subscription_term" END,
  1,
  "telegram_payment_charge_id"
FROM "subscriptions"
WHERE "telegram_payment_charge_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" DROP COLUMN "telegram_payment_charge_id";