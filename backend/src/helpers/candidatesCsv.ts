import { parse } from "csv-parse/sync";

export type CandidateInput = {
  fullName: string;
  phone: string;
  enrollmentNo: string;
};

export type CsvError = { row: number; message: string };

export function validateCandidatesCsv(buffer?: Buffer):
  | { candidates: CandidateInput[]; errors: [] }
  | { candidates: []; errors: CsvError[] } {
  if (!buffer) return { candidates: [], errors: [{ row: 1, message: "CSV file is required" }] };

  let records: Record<string, unknown>[];
  try {
    records = parse(buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
  } catch {
    return {
      candidates: [],
      errors: [{
        row: 1,
        message: "The file is not a readable CSV. Download the sample and upload a .csv file with fullName, phone, and enrollmentNo columns.",
      }],
    };
  }

  const errors: CsvError[] = [];
  const enrollmentRows = new Map<string, number>();
  const candidates = records.map((record, index) => {
    const row = index + 2;
    const candidate = {
      fullName: String(record.fullName ?? "").trim(),
      phone: String(record.phone ?? "").trim(),
      enrollmentNo: String(record.enrollmentNo ?? "").trim(),
    };

    if (!candidate.fullName) errors.push({ row, message: "fullName is required" });
    if (!/^\d{10}$/.test(candidate.phone)) errors.push({ row, message: "phone must contain exactly 10 digits" });
    if (!candidate.enrollmentNo) {
      errors.push({ row, message: "enrollmentNo is required" });
    } else if (enrollmentRows.has(candidate.enrollmentNo)) {
      errors.push({ row, message: `enrollmentNo duplicates row ${enrollmentRows.get(candidate.enrollmentNo)}` });
    } else {
      enrollmentRows.set(candidate.enrollmentNo, row);
    }
    return candidate;
  });

  if (records.length === 0) errors.push({ row: 2, message: "CSV must contain at least one candidate" });
  return errors.length ? { candidates: [], errors } : { candidates, errors: [] };
}

