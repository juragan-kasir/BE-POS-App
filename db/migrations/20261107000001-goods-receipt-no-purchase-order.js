'use strict'

module.exports = {
  async up(queryInterface) {
    // DR-15: a goods receipt may be recorded without a purchase order (e.g.
    // a direct ingredient delivery). Existing PO-backed receipts keep their
    // link; only the NOT NULL constraint is relaxed.
    await queryInterface.sequelize.query(
      'ALTER TABLE "goods_receipt" ALTER COLUMN "purchaseOrderId" DROP NOT NULL'
    )

    // Idempotency backstop for no-PO receipts. The existing
    // (purchaseOrderId, idempotencyKey) unique index cannot protect these
    // rows because PostgreSQL treats every NULL as distinct.
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS goods_receipt_store_idempotency_no_po_unique
         ON "goods_receipt" ("store", "idempotencyKey")
       WHERE "purchaseOrderId" IS NULL AND "idempotencyKey" IS NOT NULL`
    )
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      'DROP INDEX IF EXISTS goods_receipt_store_idempotency_no_po_unique'
    )
    await queryInterface.sequelize.query(
      `DO $$ BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM "goods_receipt" WHERE "purchaseOrderId" IS NULL
         ) THEN
           ALTER TABLE "goods_receipt"
             ALTER COLUMN "purchaseOrderId" SET NOT NULL;
         END IF;
       END $$`
    )
  }
}
