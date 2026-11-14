"""入库字段校验与目标解析的单元测试。"""
import pytest

from app.core.errors import AppError
from app.services.record_service import _parse_target_item_id, _validate_name_location

pytestmark = pytest.mark.unit


class TestNameLocation:
    def test_valid(self):
        _validate_name_location("数据线", "书房抽屉", name_required=True)

    def test_create_requires_name(self):
        with pytest.raises(AppError):
            _validate_name_location("", "书房抽屉", name_required=True)
        with pytest.raises(AppError):
            _validate_name_location(None, "书房抽屉", name_required=True)

    def test_move_allows_empty_name(self):
        _validate_name_location("", "书房抽屉", name_required=False)
        _validate_name_location(None, "书房抽屉", name_required=False)

    @pytest.mark.parametrize("name", ["x" * 129, 123, ["数据线"]])
    def test_bad_name_rejected(self, name):
        with pytest.raises(AppError):
            _validate_name_location(name, "书房抽屉", name_required=False)

    @pytest.mark.parametrize("loc", ["", None, "x" * 256, 42])
    def test_bad_location_rejected(self, loc):
        with pytest.raises(AppError):
            _validate_name_location("数据线", loc, name_required=False)


class TestTargetItemId:
    @pytest.mark.parametrize("raw,expected", [(21, 21), ("21", 21), (None, None)])
    def test_valid(self, raw, expected):
        assert _parse_target_item_id(raw) == expected

    @pytest.mark.parametrize("raw", ["abc", "2.5", 2.5, True, [21], {"id": 21}])
    def test_invalid(self, raw):
        assert _parse_target_item_id(raw) is None
