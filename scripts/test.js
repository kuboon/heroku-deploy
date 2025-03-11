(async () => {
  const res = await fetch("https://kuboon-deploy-test-1.herokuapp.com/");
  console.log(res.status === 200);
})();
