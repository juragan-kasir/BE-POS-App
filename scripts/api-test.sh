#!/bin/bash
# API Integration Test Script
# Tests positive and negative cases for all major endpoints

BASE_URL="https://api-bisa-nota.vercel.app"
PASS=0
FAIL=0
ERRORS=""

# Get auth token
echo "=== LOGIN ==="
LOGIN_RESP=$(curl -s -X POST "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"userName\":\"${SA_USER:-super_admin}\",\"password\":\"${SA_PASS:?set SA_PASS}\"}")
TOKEN=$(echo "$LOGIN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "❌ FAIL: Login gagal"
  echo "$LOGIN_RESP"
  exit 1
fi
echo "✅ PASS: Login berhasil (token obtained)"
PASS=$((PASS+1))

AUTH="Authorization: Bearer $TOKEN"

# Helper functions
test_case() {
  local feature=$1
  local desc=$2
  local method=$3
  local url=$4
  local data=$5
  local expected_code=$6
  
  if [ "$method" = "GET" ]; then
    RESP=$(curl -s -w "\n%{http_code}" -X GET "$url" -H "$AUTH" -H "Content-Type: application/json" --max-time 10)
  elif [ "$method" = "DELETE" ]; then
    RESP=$(curl -s -w "\n%{http_code}" -X DELETE "$url" -H "$AUTH" -H "Content-Type: application/json" -d "$data" --max-time 10)
  else
    RESP=$(curl -s -w "\n%{http_code}" -X "$method" "$url" -H "$AUTH" -H "Content-Type: application/json" -d "$data" --max-time 10)
  fi
  
  HTTP_CODE=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')
  
  if [ "$HTTP_CODE" = "$expected_code" ]; then
    echo "✅ PASS: [$feature] $desc (HTTP $HTTP_CODE)"
    PASS=$((PASS+1))
  else
    echo "❌ FAIL: [$feature] $desc (expected $expected_code, got $HTTP_CODE)"
    echo "   Response: $BODY"
    FAIL=$((FAIL+1))
    ERRORS="$ERRORS
❌ [$feature] $desc - Expected $expected_code got $HTTP_CODE: $BODY"
  fi
}

echo ""
echo "=========================================="
echo "      POSITIVE TEST CASES"
echo "=========================================="
echo ""

# ========================
# DEPARTMENT
# ========================
echo "--- DEPARTMENT ---"

# Positive: Add department
test_case "Department" "Add department (positive)" "POST" \
  "$BASE_URL/department/add-new-department" \
  '{"name":"Test Dept","description":"Test","status":true,"createdBy":"super_admin"}' \
  200

# Positive: Get all departments
test_case "Department" "Get all departments (positive)" "GET" \
  "$BASE_URL/department/get-department-all?page=1&limit=10&status=all" \
  "" 200

# Positive: Get single department (public)
test_case "Department" "Get departments public (positive)" "GET" \
  "$BASE_URL/department/get-department" \
  "" 200

# Positive: Edit department
test_case "Department" "Edit department (positive)" "PUT" \
  "$BASE_URL/department/edit-department/1" \
  '{"name":"Test Dept Updated","description":"Updated","status":true,"modifiedBy":"super_admin"}' \
  200

# Negative: Add duplicate department
test_case "Department" "Add duplicate department (negative)" "POST" \
  "$BASE_URL/department/add-new-department" \
  '{"name":"Test Dept Updated","description":"Test","status":true}' \
  403

# Negative: Add department without name
test_case "Department" "Add department no name (negative)" "POST" \
  "$BASE_URL/department/add-new-department" \
  '{"description":"No name","status":true}' \
  500

# Positive: Download template
test_case "Department" "Download template (positive)" "GET" \
  "$BASE_URL/department/download-template" \
  "" 200

# ========================
# POSITION
# ========================
echo ""
echo "--- POSITION ---"

# Positive: Add position
test_case "Position" "Add position (positive)" "POST" \
  "$BASE_URL/position/add-new-position" \
  '{"name":"Test Position","departmentId":2,"description":"Test","status":true,"createdBy":"super_admin"}' \
  200

# Positive: Get all positions
test_case "Position" "Get all positions (positive)" "GET" \
  "$BASE_URL/position/get-position-all?page=1&limit=10&status=all" \
  "" 200

# Positive: Get positions public
test_case "Position" "Get positions public (positive)" "GET" \
  "$BASE_URL/position/get-position" \
  "" 200

# Positive: Edit position
test_case "Position" "Edit position (positive)" "PUT" \
  "$BASE_URL/position/edit-position/1" \
  '{"name":"Test Position Updated","departmentId":2,"description":"Updated","status":true}' \
  200

# Negative: Add position without name
test_case "Position" "Add position no name (negative)" "POST" \
  "$BASE_URL/position/add-new-position" \
  '{"departmentId":2,"description":"No name","status":true}' \
  500

# Positive: Download template
test_case "Position" "Download template (positive)" "GET" \
  "$BASE_URL/position/download-template" \
  "" 200

# ========================
# LOCATION
# ========================
echo ""
echo "--- LOCATION ---"

# Positive: Generate location ID
test_case "Location" "Generate location ID (positive)" "GET" \
  "$BASE_URL/location/generate-id" \
  "" 200

# Positive: Get all locations
test_case "Location" "Get all locations (positive)" "GET" \
  "$BASE_URL/location/get-location" \
  "" 200

# Positive: Get locations in table
test_case "Location" "Get locations table (positive)" "GET" \
  "$BASE_URL/location/get-location-all?page=1&limit=10&status=all" \
  "" 200

# ========================
# CATEGORY
# ========================
echo ""
echo "--- CATEGORY ---"

# Positive: Add category
test_case "Category" "Add category (positive)" "POST" \
  "$BASE_URL/category/add-new-category" \
  '{"name":"Test Category","description":"Test","store":1,"status":true}' \
  200

# Positive: Get categories
test_case "Category" "Get categories (positive)" "GET" \
  "$BASE_URL/category/get-category-all?page=1&limit=10&status=all" \
  "" 200

# Negative: Add duplicate category
test_case "Category" "Add duplicate category (negative)" "POST" \
  "$BASE_URL/category/add-new-category" \
  '{"name":"Test Category","description":"Test","store":1,"status":true}' \
  403

# ========================
# DISCOUNT
# ========================
echo ""
echo "--- DISCOUNT ---"

# Positive: Add discount
test_case "Discount" "Add discount (positive)" "POST" \
  "$BASE_URL/discount/add-new-discount" \
  '{"name":"Test Disc","type":"percentage","value":10,"store":1,"status":true}' \
  200

# Positive: Get discounts
test_case "Discount" "Get discounts (positive)" "GET" \
  "$BASE_URL/discount/get-discount" \
  "" 200

# ========================
# SHIFT
# ========================
echo ""
echo "--- SHIFT ---"

# Positive: Add shift
test_case "Shift" "Add shift (positive)" "POST" \
  "$BASE_URL/shift/add-new-shift" \
  '{"name":"Test Shift","startTime":"08:00","endTime":"16:00","store":1,"status":true}' \
  200

# Positive: Get shifts
test_case "Shift" "Get shifts public (positive)" "GET" \
  "$BASE_URL/shift/get-shift" \
  "" 200

# ========================
# EXPENSE CATEGORY
# ========================
echo ""
echo "--- EXPENSE CATEGORY ---"

# Positive: Add expense category
test_case "ExpenseCategory" "Add expense category (positive)" "POST" \
  "$BASE_URL/expense-category/add" \
  '{"name":"Test Expense Cat","description":"Test"}' \
  200

# Positive: Get expense categories
test_case "ExpenseCategory" "Get expense categories (positive)" "GET" \
  "$BASE_URL/expense-category/get-all" \
  "" 200

# ========================
# SUPPLIER
# ========================
echo ""
echo "--- SUPPLIER ---"

# Positive: Add supplier
test_case "Supplier" "Add supplier (positive)" "POST" \
  "$BASE_URL/supplier/add" \
  '{"name":"Test Supplier","phone":"08123456789","address":"Test Address","store":1,"status":true}' \
  200

# Positive: Get suppliers
test_case "Supplier" "Get suppliers (positive)" "GET" \
  "$BASE_URL/supplier/get-all" \
  "" 200

# ========================
# INGREDIENT
# ========================
echo ""
echo "--- INGREDIENT ---"

# Positive: Add ingredient
test_case "Ingredient" "Add ingredient (positive)" "POST" \
  "$BASE_URL/ingredient/add" \
  '{"name":"Test Ingredient","stock":100,"unit":"pcs","store":1}' \
  200

# Positive: Get ingredients
test_case "Ingredient" "Get ingredients (positive)" "GET" \
  "$BASE_URL/ingredient/get-all" \
  "" 200

# ========================
# STOCK OPNAME
# ========================
echo ""
echo "--- STOCK OPNAME ---"

# Positive: Get stock opname list
test_case "StockOpname" "Get stock opname list (positive)" "GET" \
  "$BASE_URL/stock-opname/get-all" \
  "" 200

# ========================
# MEMBER TIER
# ========================
echo ""
echo "--- MEMBER TIER ---"

# Positive: Add member tier
test_case "MemberTier" "Add member tier (positive)" "POST" \
  "$BASE_URL/member-tier/add" \
  '{"name":"Test Tier","minPoints":0,"maxPoints":100,"discountPercent":5}' \
  200

# Positive: Get member tiers
test_case "MemberTier" "Get member tiers (positive)" "GET" \
  "$BASE_URL/member-tier/get-all" \
  "" 200

# ========================
# SOCIAL MEDIA
# ========================
echo ""
echo "--- SOCIAL MEDIA ---"

# Positive: Add social media
test_case "SocialMedia" "Add social media (positive)" "POST" \
  "$BASE_URL/social-media/add-social-media" \
  '{"name":"Instagram","url":"https://instagram.com/test","store":1}' \
  200

# Positive: Get social media
test_case "SocialMedia" "Get social media (positive)" "GET" \
  "$BASE_URL/social-media/get-social-media" \
  "" 200

# ========================
# TYPE PAYMENT
# ========================
echo ""
echo "--- TYPE PAYMENT ---"

# Positive: Add type payment
test_case "TypePayment" "Add type payment (positive)" "POST" \
  "$BASE_URL/type-payment/add-new-type-payment" \
  '{"name":"Test Payment","store":1,"status":true}' \
  200

# Positive: Get type payments
test_case "TypePayment" "Get type payments (positive)" "GET" \
  "$BASE_URL/type-payment/get-type-payment" \
  "" 200

# ========================
# SUB CATEGORY
# ========================
echo ""
echo "--- SUB CATEGORY ---"

# Positive: Add sub category
test_case "SubCategory" "Add sub category (positive)" "POST" \
  "$BASE_URL/sub-category/add-subcategory" \
  '{"name":"Test SubCat","categoryId":1,"store":1,"status":true}' \
  200

# Positive: Get sub categories
test_case "SubCategory" "Get sub categories (positive)" "GET" \
  "$BASE_URL/sub-category/get-all-sub-category" \
  "" 200

# ========================
# TABLE
# ========================
echo ""
echo "--- TABLE ---"

# Positive: Create table
test_case "Table" "Create table (positive)" "POST" \
  "$BASE_URL/table/create" \
  '{"tableNumber":99,"capacity":4,"store":1,"status":"available"}' \
  200

# Positive: Get tables
test_case "Table" "Get tables (positive)" "GET" \
  "$BASE_URL/table/get-tables" \
  "" 200

echo ""
echo "=========================================="
echo "      NEGATIVE TEST CASES"
echo "=========================================="
echo ""

# Negative: Without auth token
echo "--- WITHOUT AUTH ---"
test_case "Auth" "Get location without token (negative)" "GET" \
  "$BASE_URL/location/get-location" \
  "" 401

# Negative: Invalid token
test_case "Auth" "Get location invalid token (negative)" "GET" \
  "$BASE_URL/location/get-location" \
  "" 401

# Negative: Delete non-existent
echo ""
echo "--- NON-EXISTENT ---"
test_case "Department" "Delete non-existent department (negative)" "DELETE" \
  "$BASE_URL/department/delete-department/99999" \
  '{}' 404

test_case "Position" "Delete non-existent position (negative)" "DELETE" \
  "$BASE_URL/position/delete-position/99999" \
  '{}' 404

# Negative: Wrong method
echo ""
echo "--- WRONG METHOD ---"
test_case "Department" "GET on POST endpoint (negative)" "GET" \
  "$BASE_URL/department/add-new-department" \
  "" 404

echo ""
echo "=========================================="
echo "      SUMMARY"
echo "=========================================="
echo "✅ PASS: $PASS"
echo "❌ FAIL: $FAIL"

if [ $FAIL -gt 0 ]; then
  echo ""
  echo "ERRORS:"
  echo "$ERRORS"
fi

echo ""
echo "Done!"
