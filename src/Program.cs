using Statiq.App;
using Statiq.Web;

return await Bootstrapper
    .Factory
    .CreateWeb(args)
    .RunAsync();