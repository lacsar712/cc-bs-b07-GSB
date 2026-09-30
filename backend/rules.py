"""桥梁微应变判定：80～220 με 为合格，否则越界。"""


def judge_microstrain(microstrain: float) -> tuple[str, str]:
    if 80 <= microstrain <= 220:
        return "合格", "微应变处于 80～220 με 设计允许范围内"
    if microstrain < 80:
        return "越界", "微应变低于 80 με 设计下限"
    return "越界", "微应变高于 220 με 设计上限"
