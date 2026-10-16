#!/bin/bash
# Category API Integration Test Script
# Tests positive and negative cases for category endpoints

BASE_URL="https://api-bisa-nota.vercel.app"
PASS=0
FAIL=0
ERRORS=""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

generate_excel() {
  node -e "
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Category');
  ws.columns = [
    { header: 'No', key: 'no', width: 8 },
    { header: 'Name', key: 'name', width: 25 },
    { header: 'Description', key: 'description', width: 30 },
    { header: 'Value', key: 'value', width: 20 },
    { header: 'isActive', key: 'isActive', width: 12 }
  ];
  ws.addRow({ id: 1, name: 'Excel Category 1', description: 'From excel test', value: 'excel-category-1', isActive: true });
  ws.addRow({ id: 2, name: 'Excel Category 2', description: 'From excel test 2', value: 'excel-category-2', isActive: false });
  ws.addRow({ id: 3, name: 'Excel Category 3', description: '', value: 'excel-category-3', isActive: 'yes' });
  wb.xlsx.writeFile('/tmp/test-category.xlsx').then(() => console.log('OK'));
  " 2>/dev/null
}

generate_invalid_sheet_excel() {
  node -e "
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('WrongSheet');
  ws.columns = [{ header: 'ID', key: 'id', width: 8 }];
  ws.addRow({ id: 1 });
  wb.xlsx.writeFile('/tmp/test-category-wrong-sheet.xlsx').then(() => console.log('OK'));
  " 2>/dev/null
}

generate_wrong_header_excel() {
  node -e "
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Category');
  ws.columns = [
    { header: 'Wrong', key: 'a', width: 10 },
    { header: 'Headers', key: 'b', width: 10 },
    { header: 'Here', key: 'c', width: 10 },
    { header: 'Bad', key: 'd', width: 10 },
    { header: 'Data', key: 'e', width: 10 }
  ];
  ws.addRow({ a: 'test', b: 'data', c: 'x', d: 'y', e: 'z' });
  wb.xlsx.writeFile('/tmp/test-category-wrong-header.xlsx').then(() => console.log('OK'));
  " 2>/dev/null
}

cleanup_test_data() {
  local token=$1
  local auth="Authorization: Bearer $token"
  curl -s -X DELETE "$BASE_URL/category/delete-category/99998" -H "$auth" -H "Content-Type: application/json" -d '{}' > /dev/null 2>&1 || true
  curl -s -X DELETE "$BASE_URL/category/delete-category/99999" -H "$auth" -H "Content-Type: application/json" -d '{}' > /dev/null 2>&1 || true
}

echo "=========================================="
echo "   CATEGORY API TEST SUITE"
echo "=========================================="
echo ""

# -------------------------
# LOGIN
# -------------------------
echo "--- LOGIN ---"
LOGIN_RESP=$(curl -s -X POST "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"userName\":\"${SA_USER:-super_admin}\",\"password\":\"${SA_PASS:?set SA_PASS}\"}")
TOKEN=$(echo "$LOGIN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo -e "  ${RED}FAIL${NC}: Login gagal"
  echo "$LOGIN_RESP"
  exit 1
fi
echo -e "  ${GREEN}PASS${NC}: Login berhasil"
PASS=$((PASS+1))

AUTH="Authorization: Bearer $TOKEN"

# Cleanup any leftover test data
cleanup_test_data "$TOKEN"

# Generate test excel files
echo ""
echo "--- GENERATE TEST FILES ---"
generate_excel
if [ -f /tmp/test-category.xlsx ]; then
  echo -e "  ${GREEN}PASS${NC}: Generate valid excel"
  PASS=$((PASS+1))
else
  echo -e "  ${RED}FAIL${NC}: Generate valid excel"
  FAIL=$((FAIL+1))
fi

generate_invalid_sheet_excel
generate_wrong_header_excel

# Helper
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
    echo -e "  ${GREEN}PASS${NC}: [$feature] $desc (HTTP $HTTP_CODE)"
    PASS=$((PASS+1))
  else
    echo -e "  ${RED}FAIL${NC}: [$feature] $desc (expected $expected_code, got $HTTP_CODE)"
    echo "   Response: $BODY"
    FAIL=$((FAIL+1))
    ERRORS="$ERRORS
${RED}FAIL${NC}: [$feature] $desc - Expected $expected_code got $HTTP_CODE: $BODY"
  fi
}

test_case_upload() {
  local desc=$1
  local url=$2
  local file_path=$3
  local file_field=$4
  local expected_code=$5

  RESP=$(curl -s -w "\n%{http_code}" -X POST "$url" \
    -H "$AUTH" \
    -F "$file_field=@$file_path" \
    --max-time 10)

  HTTP_CODE=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')

  if [ "$HTTP_CODE" = "$expected_code" ]; then
    echo -e "  ${GREEN}PASS${NC}: [Upload] $desc (HTTP $HTTP_CODE)"
    PASS=$((PASS+1))
  else
    echo -e "  ${RED}FAIL${NC}: [Upload] $desc (expected $expected_code, got $HTTP_CODE)"
    echo "   Response: $BODY"
    FAIL=$((FAIL+1))
    ERRORS="$ERRORS
${RED}FAIL${NC}: [Upload] $desc - Expected $expected_code got $HTTP_CODE: $BODY"
  fi
}

# ==========================================
# POSITIVE TEST CASES
# ==========================================
echo ""
echo "=========================================="
echo "      POSITIVE TEST CASES"
echo "=========================================="
echo ""

# 1. Download template
echo "--- DOWNLOAD TEMPLATE ---"
test_case "Download" "Download Excel template (positive)" "GET" \
  "$BASE_URL/category/download-template" \
  "" 200

# 2. Add category (positive)
echo ""
echo "--- ADD CATEGORY ---"
test_case "Create" "Add category with description (positive)" "POST" \
  "$BASE_URL/category/add-new-category" \
  '{"name":"Test Category A","description":"Test description for category","value":"test-category-a","store":1,"status":true,"createdBy":"super_admin"}' \
  200

test_case "Create" "Add category without value (auto-generate from name) (positive)" "POST" \
  "$BASE_URL/category/add-new-category" \
  '{"name":"Test Category B","description":"Auto value test","store":1,"status":true}' \
  200

test_case "Create" "Add inactive category (positive)" "POST" \
  "$BASE_URL/category/add-new-category" \
  '{"name":"Test Category C","description":"Inactive category","store":1,"status":false}' \
  200

# 3. Get all categories (table view)
echo ""
echo "--- GET CATEGORIES (TABLE) ---"
test_case "List" "Get all categories with pagination (positive)" "GET" \
  "$BASE_URL/category/get-category-all?page=1&pageSize=10&status=all" \
  "" 200

# Validate response structure - check stats and pagination fields
echo ""
echo "--- VALIDATE RESPONSE STRUCTURE ---"
LIST_RESP=$(curl -s -X GET "$BASE_URL/category/get-category-all?page=1&pageSize=10&status=all" \
  -H "$AUTH" -H "Content-Type: application/json" --max-time 10)

# Check data is array
DATA_CHECK=$(echo "$LIST_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(isinstance(d.get('data'),list))" 2>/dev/null)
if [ "$DATA_CHECK" = "True" ]; then
  echo -e "  ${GREEN}PASS${NC}: [Response] data field is an array"
  PASS=$((PASS+1))
else
  echo -e "  ${RED}FAIL${NC}: [Response] data field should be array"
  echo "   Response: $LIST_RESP"
  FAIL=$((FAIL+1))
fi

# Check total is integer
TOTAL_CHECK=$(echo "$LIST_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(isinstance(d.get('total'),(int,float)))" 2>/dev/null)
if [ "$TOTAL_CHECK" = "True" ]; then
  echo -e "  ${GREEN}PASS${NC}: [Response] total field exists"
  PASS=$((PASS+1))
else
  echo -e "  ${RED}FAIL${NC}: [Response] total should be integer"
  FAIL=$((FAIL+1))
fi

# Check stats structure
STATS_CHECK=$(echo "$LIST_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
s=d.get('stats',{})
ok = isinstance(s.get('total'),(int,float)) and isinstance(s.get('active'),(int,float)) and isinstance(s.get('inactive'),(int,float))
print(ok)
" 2>/dev/null)
if [ "$STATS_CHECK" = "True" ]; then
  echo -e "  ${GREEN}PASS${NC}: [Response] stats {total, active, inactive} valid"
  PASS=$((PASS+1))
else
  echo -e "  ${RED}FAIL${NC}: [Response] stats structure invalid"
  echo "   Response: $LIST_RESP"
  FAIL=$((FAIL+1))
fi

# Check pagination structure
PAG_CHECK=$(echo "$LIST_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
p=d.get('pagination',{})
ok = isinstance(p.get('total'),(int,float)) and isinstance(p.get('totalPages'),(int,float))
print(ok)
" 2>/dev/null)
if [ "$PAG_CHECK" = "True" ]; then
  echo -e "  ${GREEN}PASS${NC}: [Response] pagination {total, totalPages} valid"
  PASS=$((PASS+1))
else
  echo -e "  ${RED}FAIL${NC}: [Response] pagination structure invalid"
  echo "   Response: $LIST_RESP"
  FAIL=$((FAIL+1))
fi

# Check data items have code field
CODE_CHECK=$(echo "$LIST_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
items=d.get('data',[])
for item in items:
    if item.get('name') == 'Test Category A':
        print(item.get('code','') or False)
        break
else:
    print(False)
" 2>/dev/null)
if [ "$CODE_CHECK" != "False" ] && [ "$CODE_CHECK" != "" ]; then
  echo -e "  ${GREEN}PASS${NC}: [Response] data items include code field ($CODE_CHECK)"
  PASS=$((PASS+1))
else
  echo -e "  ${RED}FAIL${NC}: [Response] data items should include code field"
  echo "   Response: $LIST_RESP"
  FAIL=$((FAIL+1))
fi

# Check data items have productCount field
PC_CHECK=$(echo "$LIST_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
items=d.get('data',[])
for item in items:
    if item.get('name') == 'Test Category A':
        print(isinstance(item.get('productCount'),(int,float)))
        print(item.get('productCount'))
        break
else:
    print(False)
    print(0)
" 2>/dev/null)
PC_OK=$(echo "$PC_CHECK" | head -1)
PC_VAL=$(echo "$PC_CHECK" | tail -1)
if [ "$PC_OK" = "True" ]; then
  echo -e "  ${GREEN}PASS${NC}: [Response] data items include productCount ($PC_VAL)"
  PASS=$((PASS+1))
else
  echo -e "  ${RED}FAIL${NC}: [Response] data items should include productCount"
  echo "   Response: $LIST_RESP"
  FAIL=$((FAIL+1))
fi

# Check data items have description field
DESC_CHECK=$(echo "$LIST_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
items=d.get('data',[])
for item in items:
    if item.get('name') == 'Test Category A':
        print('description' in item)
        break
else:
    print(False)
" 2>/dev/null)
if [ "$DESC_CHECK" = "True" ]; then
  echo -e "  ${GREEN}PASS${NC}: [Response] data items include description field"
  PASS=$((PASS+1))
else
  echo -e "  ${RED}FAIL${NC}: [Response] data items should include description"
  echo "   Response: $LIST_RESP"
  FAIL=$((FAIL+1))
fi

# 4. Get active categories (cashier list)
echo ""
echo "--- GET CATEGORIES (CASHIER LIST) ---"
test_case "List" "Get active categories (positive)" "GET" \
  "$BASE_URL/category/get-category" \
  "" 200

# 5. Edit category
echo ""
echo "--- EDIT CATEGORY ---"
# First get the ID of a category we created
GET_ID_RESP=$(curl -s -X GET "$BASE_URL/category/get-category-all?pageSize=50" -H "$AUTH" -H "Content-Type: application/json" --max-time 10)
CAT_ID=$(echo "$GET_ID_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for item in d.get('data',[]):
    if item.get('name') == 'Test Category A':
        print(item['id'])
        break
" 2>/dev/null)

if [ -n "$CAT_ID" ] && [ "$CAT_ID" != "None" ]; then
  # Edit with new description
  test_case "Edit" "Edit category description and name (positive)" "PUT" \
    "$BASE_URL/category/edit-category/$CAT_ID" \
    "{\"id\":$CAT_ID,\"name\":\"Test Category A Updated\",\"description\":\"Updated description\",\"value\":\"test-category-a-updated\",\"status\":true,\"modifiedBy\":\"super_admin\"}" \
    200

  # Verify the edit by checking description
  VERIFY_RESP=$(curl -s -X GET "$BASE_URL/category/get-category-all?pageSize=50" -H "$AUTH" -H "Content-Type: application/json" --max-time 10)
  VERIFY_DESC=$(echo "$VERIFY_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for item in d.get('data',[]):
    if item.get('name') == 'Test Category A Updated':
        print(item.get('description',''))
        break
" 2>/dev/null)
  if [ "$VERIFY_DESC" = "Updated description" ]; then
    echo -e "  ${GREEN}PASS${NC}: [Edit] Description updated correctly"
    PASS=$((PASS+1))
  else
    echo -e "  ${RED}FAIL${NC}: [Edit] Description not updated (got: $VERIFY_DESC)"
    FAIL=$((FAIL+1))
  fi

  # Edit status to inactive
  test_case "Edit" "Edit category status to inactive (positive)" "PUT" \
    "$BASE_URL/category/edit-category/$CAT_ID" \
    "{\"id\":$CAT_ID,\"name\":\"Test Category A Updated\",\"description\":\"Updated description\",\"value\":\"test-category-a-updated\",\"status\":false,\"modifiedBy\":\"super_admin\"}" \
    200

  # Reactivate again for cleanup
  test_case "Edit" "Edit category status to active (positive)" "PUT" \
    "$BASE_URL/category/edit-category/$CAT_ID" \
    "{\"id\":$CAT_ID,\"name\":\"Test Category A Updated\",\"description\":\"Updated description\",\"value\":\"test-category-a-updated\",\"status\":true,\"modifiedBy\":\"super_admin\"}" \
    200
else
  echo -e "  ${RED}FAIL${NC}: [Edit] Could not find test category to edit"
  FAIL=$((FAIL+1))
fi

# 6. Upload Excel
echo ""
echo "--- UPLOAD EXCEL ---"
test_case_upload "Upload valid Excel file (positive)" \
  "$BASE_URL/category/upload-excel" \
  "/tmp/test-category.xlsx" \
  "file" 201

# 7. Filter by status
echo ""
echo "--- FILTER ---"
test_case "Filter" "Get active categories only (positive)" "GET" \
  "$BASE_URL/category/get-category-all?page=1&pageSize=10&status=true" \
  "" 200

test_case "Filter" "Get inactive categories only (positive)" "GET" \
  "$BASE_URL/category/get-category-all?page=1&pageSize=10&status=false" \
  "" 200

# 8. Pagination
echo ""
echo "--- PAGINATION ---"
test_case "Pagination" "Get page 1 with small pageSize (positive)" "GET" \
  "$BASE_URL/category/get-category-all?page=1&pageSize=2" \
  "" 200

# ==========================================
# NEGATIVE TEST CASES
# ==========================================
echo ""
echo "=========================================="
echo "      NEGATIVE TEST CASES"
echo "=========================================="
echo ""

# 1. Duplicate category
echo "--- DUPLICATE ---"
test_case "Negative" "Add duplicate category name (negative)" "POST" \
  "$BASE_URL/category/add-new-category" \
  '{"name":"Test Category A Updated","store":1,"status":true}' \
  403

test_case "Negative" "Add duplicate category from upload (negative)" "POST" \
  "$BASE_URL/category/add-new-category" \
  '{"name":"Test Category B","store":1,"status":true}' \
  403

# 2. Missing required fields
echo ""
echo "--- MISSING FIELDS ---"
test_case "Negative" "Add category without name (negative)" "POST" \
  "$BASE_URL/category/add-new-category" \
  '{"store":1,"status":true}' \
  500

test_case "Negative" "Add category with empty name (negative)" "POST" \
  "$BASE_URL/category/add-new-category" \
  '{"name":"","store":1,"status":true}' \
  500

# 3. Invalid operations
echo ""
echo "--- INVALID OPERATIONS ---"
test_case "Negative" "Edit non-existent category (negative)" "PUT" \
  "$BASE_URL/category/edit-category/99999" \
  '{"id":99999,"name":"NonExistent","status":true}' \
  404

test_case "Negative" "Delete non-existent category (negative)" "DELETE" \
  "$BASE_URL/category/delete-category/99999" \
  '{"id":99999,"name":"NonExistent"}' \
  403

# 4. Upload errors
echo ""
echo "--- UPLOAD ERRORS ---"
test_case "Negative" "Upload without file (negative)" "POST" \
  "$BASE_URL/category/upload-excel" \
  "" 400

test_case_upload "Upload with wrong sheet name (negative)" \
  "$BASE_URL/category/upload-excel" \
  "/tmp/test-category-wrong-sheet.xlsx" \
  "file" 400

test_case_upload "Upload with wrong headers (negative)" \
  "$BASE_URL/category/upload-excel" \
  "/tmp/test-category-wrong-header.xlsx" \
  "file" 400

# 5. Auth errors
echo ""
echo "--- AUTH ERRORS ---"
NO_AUTH_RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE_URL/category/get-category" --max-time 10)
NO_AUTH_CODE=$(echo "$NO_AUTH_RESP" | tail -1)
if [ "$NO_AUTH_CODE" = "401" ]; then
  echo -e "  ${GREEN}PASS${NC}: [Auth] Get category without token returns 401"
  PASS=$((PASS+1))
else
  echo -e "  ${RED}FAIL${NC}: [Auth] Get category without token (expected 401, got $NO_AUTH_CODE)"
  FAIL=$((FAIL+1))
fi

# Invalid token
INV_AUTH="Authorization: Bearer invalid_token_12345"
INV_RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE_URL/category/get-category" -H "$INV_AUTH" -H "Content-Type: application/json" --max-time 10)
INV_CODE=$(echo "$INV_RESP" | tail -1)
if [ "$INV_CODE" = "401" ]; then
  echo -e "  ${GREEN}PASS${NC}: [Auth] Get category with invalid token returns 401"
  PASS=$((PASS+1))
else
  echo -e "  ${RED}FAIL${NC}: [Auth] Get category with invalid token (expected 401, got $INV_CODE)"
  FAIL=$((FAIL+1))
fi

# 6. Wrong method
echo ""
echo "--- WRONG METHOD ---"
test_case "Method" "GET on POST endpoint (negative)" "GET" \
  "$BASE_URL/category/add-new-category" \
  "" 404

# 7. Large page number
echo ""
echo "--- EDGE CASES ---"
test_case "Edge" "Get page with extremely large number (negative)" "GET" \
  "$BASE_URL/category/get-category-all?page=99999&pageSize=10" \
  "" 200

# ==========================================
# SUMMARY
# ==========================================
echo ""
echo "=========================================="
echo "      SUMMARY"
echo "=========================================="
echo -e "  ${GREEN}PASS${NC}: $PASS"
echo -e "  ${RED}FAIL${NC}: $FAIL"

if [ $FAIL -gt 0 ]; then
  echo ""
  echo "ERRORS:"
  echo "$ERRORS"
  exit 1
fi
echo ""
echo "All category tests passed!"
