import { css, Global } from "@emotion/react";
import { useEffect, useState } from "react";

import Footer from "./components/Footer";
import Header from "./components/Header/Header";
import Main from "./components/Main/Main";
import Syllabi from "./components/Syllabi";
import Timetable from "./components/Timetable/Index";
import TwinsSync from "./components/TwinsSync";
import {
  createSearchOptions,
  type SearchOptions,
  searchSubjects,
} from "./utils/search";
import { CURRENT_YEAR, kdb, type Subject } from "./utils/subject";
import { twinsModuleFromTermCode } from "./utils/twins";
import { useBookmark } from "./utils/useBookmark";
import { useClassroom } from "./utils/useClassroom";
import { useTwins } from "./utils/useTwins";

const globalStyle = css`
  html,
  body {
    margin: 0;
    padding: 0;
    -webkit-text-size-adjust: 100%;
    background: #fff;
  }

  a {
    cursor: pointer;
  }

  * {
    font-family: "Noto Sans JP", sans-serif;
  }

  @font-face {
    font-family: "Noto Sans JP";
    font-weight: 400;
    font-display: swap;
    src: url("./NotoSansJP-Regular.ttf");
  }

  @font-face {
    font-family: "Noto Sans JP";
    font-weight: 700;
    font-display: swap;
    src: url("./NotoSansJP-Bold.ttf");
  }
`;

const App = () => {
  const [searchOptions, setSearchOptions] = useState<SearchOptions>(
    createSearchOptions(),
  );
  const [filteredSubjects, setFilteredSubjects] = useState<Subject[]>([]);
  const [timetableTermCode, setTimetableTermCode] = useState(0);
  const [displaysPlan, setDisplaysPlan] = useState(false);
  const [syllabiSubjectCode, setSyllabiSubjectCode] = useState<string | null>(
    null,
  );

  const twins = useTwins();
  const twinsModule = twinsModuleFromTermCode(timetableTermCode);
  const twinsSnapshot = twinsModule ? twins.snapshots[twinsModule] : undefined;
  const usedBookmark = useBookmark(
    timetableTermCode,
    setTimetableTermCode,
    twinsSnapshot,
  );
  const { bookmarkTimeslotTable, bookmarksHas } = usedBookmark;

  const usedClassroom = useClassroom();
  const [syncOpen, setSyncOpen] = useState(false);
  const { syncTwinsCourses } = usedBookmark;

  useEffect(() => {
    if (twins.importCodes) syncTwinsCourses(twins.importCodes);
  }, [twins.importCodes, syncTwinsCourses]);

  const openSync = () => {
    setSyncOpen(true);
    if (twinsModule)
      void twins.review(
        twinsModule,
        CURRENT_YEAR,
        usedBookmark.getTwinsPlanCodes(
          twinsModule,
          twinsSnapshot?.entries.map((entry) => entry.code),
        ),
      );
  };

  // debounce 時間
  const DEBOUNCE_TIME = 100;

  useEffect(() => {
    // 履修計画の画面ではブックマークに登録された全科目を表示
    const planSearchOptions = createSearchOptions();
    planSearchOptions.filter = "bookmark";
    const options = displaysPlan ? planSearchOptions : searchOptions;

    const timer = setTimeout(() => {
      // 検索結果を更新
      const subjects = searchSubjects(
        kdb.subjectMap,
        kdb.subjectCodeList,
        options,
        bookmarkTimeslotTable,
        bookmarksHas,
      );
      setFilteredSubjects(subjects);
    }, DEBOUNCE_TIME);

    return () => {
      clearTimeout(timer);
    };
  }, [searchOptions, bookmarkTimeslotTable, displaysPlan, bookmarksHas]);

  return (
    <>
      <Global styles={globalStyle} />
      <Header
        searchOptions={searchOptions}
        bookmarkTimeslotTable={usedBookmark.bookmarkTimeslotTable}
        displaysPlan={displaysPlan}
        setSearchOptions={setSearchOptions}
        setDisplaysPlan={setDisplaysPlan}
      />
      <Main
        filteredSubjects={filteredSubjects}
        displaysPlan={displaysPlan}
        usedBookmark={usedBookmark}
        usedClassroom={usedClassroom}
        setSearchOptions={setSearchOptions}
        setSyllabiSubjectCode={setSyllabiSubjectCode}
      />
      <Footer filteredSubjects={filteredSubjects} />
      <Timetable
        termCode={timetableTermCode}
        usedBookmark={usedBookmark}
        setTermCode={setTimetableTermCode}
        twinsSnapshot={twinsSnapshot}
        onSync={twins.available ? openSync : undefined}
        syncBusy={Boolean(twins.busy)}
        syncError={twins.error}
      />
      <TwinsSync
        isOpen={syncOpen}
        onClose={() => setSyncOpen(false)}
        twins={twins}
        usedBookmark={usedBookmark}
        module={twinsModule}
      />
      <Syllabi
        subjectCode={syllabiSubjectCode}
        setSubjectCode={setSyllabiSubjectCode}
      />
    </>
  );
};

export default App;
