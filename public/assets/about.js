fetch('data/site.json')
  .then((r) => r.json())
  .then((s) => { if (s.repo) document.getElementById('repo-link').href = s.repo; })
  .catch(() => {});
