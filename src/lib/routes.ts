import Today from '../routes/Today.svelte';
import Day from '../routes/Day.svelte';
import Meal from '../routes/Meal.svelte';
import Recipes from '../routes/Recipes.svelte';
import RecipeEditor from '../routes/RecipeEditor.svelte';
import Settings from '../routes/Settings.svelte';
import Setup from '../routes/Setup.svelte';
import About from '../routes/About.svelte';
import NotFound from '../routes/NotFound.svelte';

/**
 * Hash-based routes (svelte-spa-router). Hash routing means the static server
 * needs no rewrite rules — every URL is the same document.
 */
export const routes = {
  '/': Today,
  '/day/:date': Day,
  '/day/:date/:mealId': Meal,
  '/recipes': Recipes,
  '/recipes/:id/edit': RecipeEditor,
  '/settings': Settings,
  '/setup': Setup,
  '/about': About,
  '*': NotFound
};
