import journal from "./meta/_journal.json";
import m0000 from "./0000_shocking_vulture.sql";
import m0001 from "./0001_bitter_whirlwind.sql";
import m0002 from "./0002_tranquil_stranger.sql";
import m0003 from "./0003_special_quicksilver.sql";
import m0004 from "./0004_pay_periods_start_stop.sql";

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
    m0004,
  },
};
