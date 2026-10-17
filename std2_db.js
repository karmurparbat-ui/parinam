// Std 2 uses school-scoped server records separate from the other standards.
let std2Students = null;
let std2Writes = Promise.resolve();
async function openStd2DB() {
  const account = await window.schoolReady;
  if (!account) throw new Error('પહેલાં school login કરો.');
  return account;
}

async function s2GetAllStudents(std = 2) {
  const students = (await cloudRead('std2students', '2')) || [];
  std2Students = structuredClone(students);
  return students.filter(student => Number(student.std) === Number(std));
}

function changeStd2Students(update) {
  const work = std2Writes.then(async () => {
    if (std2Students === null) std2Students = (await cloudRead('std2students', '2')) || [];
    const students = update(structuredClone(std2Students));
    await cloudWrite('std2students', '2', students);
    std2Students = students;
    return true;
  });
  std2Writes = work.catch(() => {});
  return work;
}

function s2SaveStudent(student) {
  const snapshot = structuredClone(student);
  return changeStd2Students(students => {
    const index = students.findIndex(item => item.id === student.id);
    if (index === -1) students.push(snapshot);
    else students[index] = snapshot;
    return students;
  });
}

function s2DeleteStudent(id) {
  return changeStd2Students(students => students.filter(student => student.id !== id));
}

async function s2GetSchool() {
  const info = await cloudRead('std2school', '2');
  const account = await window.schoolReady;
  return { schoolName: account.schoolName, ...(info || {}) };
}

function s2SaveSchool(data) {
  return cloudWrite('std2school', '2', { ...data, id: 'main' });
}
